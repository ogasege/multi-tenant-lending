import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Webhook } from 'standardwebhooks';
import pg from 'pg';
import request from 'supertest';
import { inject } from 'vitest';

import { TokenService } from '@/common/auth/token.service';
import { TransactionRunner } from '@/common/database/transaction-runner';
import { OutboxWriter } from '@/common/outbox/outbox-writer';
import { REDIS } from '@/common/redis/redis.module';
import { WEBHOOK_TLS_CA, WebhookDispatcher } from '@/modules/webhooks/worker/webhook-dispatcher';
import { EndOfDayScheduler } from '@/worker/end-of-day/end-of-day.scheduler';
import { localDateTime, previousDate } from '@/worker/end-of-day/local-clock';
import { WebhooksModule } from '@/modules/webhooks/webhooks.module';

import { createPlatformAdmin, STRONG_PASSWORD } from '../fixtures/identity';
import { createTestTenant, type TestTenant } from '../fixtures/tenants';
import { TEST_TLS_CERT, TEST_TLS_KEY } from '../fixtures/tls';
import { createTestApp, type TestApp } from '../setup/app';
import { TEST_DB } from '../setup/postgres';
import { createTestWorker, type TestWorker } from '../setup/worker';

interface Received {
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** Redrive limit of this file's queue (production: 5); kept small so the DLQ test is fast. */
const MAX_RECEIVES = 3;

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}

describe('worker: outbox relay → SQS → signed webhooks; directory projection', () => {
  const env = inject('env');
  const aws = {
    region: env.AWS_REGION,
    endpoint: env.AWS_ENDPOINT_URL,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  };
  const sqs = new SQSClient(aws);
  const received: Received[] = [];
  let server: Server;
  let baseUrl: string;
  let dlqUrl: string;
  let t: TestApp;
  let worker: TestWorker;
  let tenant: TestTenant;
  let runner: TransactionRunner;

  const api = (method: 'get' | 'post' | 'delete' | 'patch', path: string, token: string) =>
    request(t.http)[method](path).set('Authorization', `Bearer ${token}`);

  const createEndpoint = async (path: string, eventTypes: string[]) => {
    const res = await api('post', '/v1/webhook-endpoints', tenant.tokens.INSTITUTION_ADMIN)
      .send({ url: `${baseUrl}${path}`, eventTypes })
      .expect(201);
    return res.body as { id: string; secret: string };
  };

  const publish = (type: string, data: Record<string, unknown>) =>
    runner.runForTenant(tenant.tenantId, (tx) =>
      t.app.get(OutboxWriter).publish(tx, {
        tenantId: tenant.tenantId,
        type,
        aggregateType: 'test',
        aggregateId: randomUUID(),
        data,
      }),
    );

  const deliveries = (eventId: string) =>
    runner.runForTenant(tenant.tenantId, (tx) =>
      tx
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('event_id', '=', eventId)
        .orderBy('attempt')
        .execute(),
    );

  beforeAll(async () => {
    // HTTPS receiver with a test-only certificate for localhost (dual-stack).
    server = createServer({ cert: TEST_TLS_CERT, key: TEST_TLS_KEY }, (req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({
          path: req.url ?? '',
          headers: req.headers as Record<string, string>,
          body,
        });
        res.statusCode = req.url?.startsWith('/fail') ? 500 : 204;
        res.end();
      });
    });
    server.listen(0);
    await once(server, 'listening');
    baseUrl = `https://localhost:${(server.address() as AddressInfo).port}`;

    // A queue + DLQ of our own, with the production redrive shape (smaller limit).
    const suffix = randomUUID().slice(0, 8);
    dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: `wh-dlq-${suffix}` }))).QueueUrl!;
    const dlqArn = (
      await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
      )
    ).Attributes!.QueueArn!;
    const queueUrl = (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: `wh-events-${suffix}`,
          Attributes: {
            VisibilityTimeout: '30',
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: dlqArn,
              maxReceiveCount: String(MAX_RECEIVES),
            }),
          },
        }),
      )
    ).QueueUrl!;

    const overrides = {
      WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true',
      SQS_DOMAIN_EVENTS_QUEUE_URL: queueUrl,
    };
    t = await createTestApp([WebhooksModule], overrides);
    runner = t.app.get(TransactionRunner);
    tenant = await createTestTenant(t.app);

    // Earlier spec files leave thousands of unpublished outbox rows (no worker ran for them).
    // Mark that backlog published so this file's relay only carries its own events and every
    // wait below depends on this file's work alone, not on how much the suite ran before.
    const db = new pg.Client({
      host: env.DATABASE_HOST,
      port: Number(env.DATABASE_PORT),
      database: env.DATABASE_NAME,
      user: 'lending_worker',
      password: TEST_DB.workerPassword,
    });
    await db.connect();
    try {
      await db.query('UPDATE outbox_events SET published_at = now() WHERE published_at IS NULL');
    } finally {
      await db.end();
    }

    worker = await createTestWorker(
      {
        ...overrides,
        SQS_WAIT_TIME_SECONDS: '1',
        OUTBOX_POLL_INTERVAL_MS: '100',
        OUTBOX_BATCH_SIZE: '200',
        // Immediate redelivery: the schedule itself is unit-tested.
        WEBHOOK_RETRY_BASE_SECONDS: '0',
        WEBHOOK_RETRY_MAX_SECONDS: '0',
        // Ticks are driven explicitly below instead of on start-up.
        EOD_SCHEDULER_ENABLED: 'false',
      },
      (b) => b.overrideProvider(WEBHOOK_TLS_CA).useValue(TEST_TLS_CERT),
    );
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
    server.close();
    sqs.destroy();
  });

  describe('webhook endpoints API', () => {
    it('returns the signing secret once and never lists it', async () => {
      const created = await createEndpoint('/ok/listing', ['loan.disbursed']);
      expect(created.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);

      const list = await api(
        'get',
        '/v1/webhook-endpoints',
        tenant.tokens.INSTITUTION_ADMIN,
      ).expect(200);
      const item = (list.body.items as Record<string, unknown>[]).find((i) => i.id === created.id);
      expect(item).toMatchObject({ url: `${baseUrl}/ok/listing`, status: 'ACTIVE' });
      expect(JSON.stringify(list.body)).not.toContain('whsec_');
      expect(Object.keys(item ?? {})).not.toContain('secret');

      const stored = await runner.runForTenant(tenant.tenantId, (tx) =>
        tx
          .selectFrom('webhook_endpoints')
          .select('secret_ciphertext')
          .where('id', '=', created.id)
          .executeTakeFirstOrThrow(),
      );
      expect(stored.secret_ciphertext).not.toContain(created.secret.slice(6));

      const audit = await runner.runForTenant(tenant.tenantId, (tx) =>
        tx
          .selectFrom('audit_log')
          .select('after_state')
          .where('entity_id', '=', created.id)
          .executeTakeFirstOrThrow(),
      );
      expect(JSON.stringify(audit.after_state)).not.toContain('whsec_');
    });

    it('audits the endpoint URL without its query string or fragment', async () => {
      const res = await api('post', '/v1/webhook-endpoints', tenant.tokens.INSTITUTION_ADMIN)
        .send({ url: `${baseUrl}/ok/audited?token=s3cr3t-in-query#frag`, eventTypes: ['x.y'] })
        .expect(201);
      const id = (res.body as { id: string }).id;
      await api('delete', `/v1/webhook-endpoints/${id}`, tenant.tokens.INSTITUTION_ADMIN).expect(
        204,
      );
      const rows = await runner.runForTenant(tenant.tenantId, (tx) =>
        tx
          .selectFrom('audit_log')
          .select(['action', 'before_state', 'after_state'])
          .where('entity_id', '=', id)
          .orderBy('id')
          .execute(),
      );
      expect(rows.map((r) => r.action)).toEqual([
        'webhook_endpoint.created',
        'webhook_endpoint.disabled',
      ]);
      for (const row of rows) {
        expect(JSON.stringify([row.before_state, row.after_state])).not.toContain('s3cr3t');
      }
      expect(rows[0]?.after_state).toMatchObject({ url: `${baseUrl}/ok/audited` });
    });

    it('rotates the secret (new one shown once) and disables via DELETE', async () => {
      const created = await createEndpoint('/ok/rotate', ['loan.disbursed']);
      const rotated = await api(
        'post',
        `/v1/webhook-endpoints/${created.id}/rotate-secret`,
        tenant.tokens.INSTITUTION_ADMIN,
      ).expect(200);
      expect(rotated.body.secret).toMatch(/^whsec_/);
      expect(rotated.body.secret).not.toBe(created.secret);

      await api(
        'delete',
        `/v1/webhook-endpoints/${created.id}`,
        tenant.tokens.INSTITUTION_ADMIN,
      ).expect(204);
      await api(
        'delete',
        `/v1/webhook-endpoints/${created.id}`,
        tenant.tokens.INSTITUTION_ADMIN,
      ).expect(204);
      const disabled = await api(
        'get',
        '/v1/webhook-endpoints?status=DISABLED',
        tenant.tokens.INSTITUTION_ADMIN,
      ).expect(200);
      expect((disabled.body.items as { id: string }[]).map((i) => i.id)).toContain(created.id);
      await api(
        'post',
        `/v1/webhook-endpoints/${created.id}/rotate-secret`,
        tenant.tokens.INSTITUTION_ADMIN,
      ).expect(409);
    });

    it('enforces https, RBAC and tenant isolation', async () => {
      const post = (body: object, token = tenant.tokens.INSTITUTION_ADMIN) =>
        api('post', '/v1/webhook-endpoints', token).send(body);
      const http = await post({
        url: 'http://localhost/hook',
        eventTypes: ['loan.disbursed'],
      }).expect(422);
      expect(http.body).toMatchObject({ code: 'UNSAFE_WEBHOOK_URL', reason: 'NOT_HTTPS' });
      await post({ url: `${baseUrl}/x`, eventTypes: ['Not An Event'] }).expect(400);
      await post({ url: `${baseUrl}/x`, eventTypes: [] }).expect(400);
      await post(
        { url: `${baseUrl}/x`, eventTypes: ['loan.disbursed'] },
        tenant.tokens.AUDITOR,
      ).expect(403);

      const created = await createEndpoint('/ok/isolation', ['loan.disbursed']);
      const other = await createTestTenant(t.app);
      await api(
        'delete',
        `/v1/webhook-endpoints/${created.id}`,
        other.tokens.INSTITUTION_ADMIN,
      ).expect(404);
      const otherList = await api(
        'get',
        '/v1/webhook-endpoints',
        other.tokens.INSTITUTION_ADMIN,
      ).expect(200);
      expect(otherList.body.items).toEqual([]);
    });
  });

  describe('delivery', () => {
    it('relays an outbox row to SQS and delivers a correctly signed webhook', async () => {
      const endpoint = await createEndpoint('/ok/deliver', ['test.delivered']);
      const eventId = await publish('test.delivered', { amount: 1500n, reference: 'R-1' });

      const hit = await waitFor(
        () => Promise.resolve(received.find((r) => r.headers['webhook-id'] === eventId)),
        'the webhook request',
      );
      expect(hit.path).toBe('/ok/deliver');
      expect(hit.headers['content-type']).toBe('application/json');
      const payload = new Webhook(endpoint.secret).verify(hit.body, hit.headers);
      expect(payload).toMatchObject({
        id: eventId,
        type: 'test.delivered',
        data: { amount: '1500', reference: 'R-1' },
      });

      const rows = await waitFor(async () => {
        const r = await deliveries(eventId);
        return r.length > 0 ? r : undefined;
      }, 'the delivery record');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        endpoint_id: endpoint.id,
        attempt: 1,
        status: 'SUCCEEDED',
        response_status: 204,
        error: null,
      });
      expect(rows[0]?.duration_ms).toEqual(expect.any(Number));

      const outbox = await runner.runForTenant(tenant.tenantId, (tx) =>
        tx
          .selectFrom('outbox_events')
          .select(['published_at', 'attempts'])
          .where('id', '=', eventId)
          .executeTakeFirstOrThrow(),
      );
      expect(outbox.published_at).toBeInstanceOf(Date);
      expect(outbox.attempts).toBe(0);
    });

    it('signs the event stored in the outbox, never the queue body (and only for its tenant)', async () => {
      await createEndpoint('/ok/stored-first', ['test.stored']);
      const eventId = await publish('test.stored', { amount: '10', reference: 'R-STORED' });
      await waitFor(
        () => Promise.resolve(received.find((r) => r.headers['webhook-id'] === eventId)),
        'the genuine delivery',
      );
      await waitFor(async () => {
        const r = await deliveries(eventId);
        return r.length > 0 ? r : undefined;
      }, 'the genuine delivery record');

      // A second subscriber, then a tampered copy of the message: forged data and type.
      const late = await createEndpoint('/ok/stored-late', ['test.stored']);
      const dispatcher = worker.app.get(WebhookDispatcher);
      const tampered = {
        id: eventId,
        tenantId: tenant.tenantId,
        type: 'test.stored',
        aggregateType: 'test',
        aggregateId: randomUUID(),
        occurredAt: new Date(0).toISOString(),
        data: { amount: '99999999', reference: 'FORGED' },
      };
      await expect(dispatcher.dispatch(tampered)).resolves.toBe('delivered');
      const hit = received.find(
        (r) => r.headers['webhook-id'] === eventId && r.path === '/ok/stored-late',
      );
      expect(hit).toBeDefined();
      const payload = new Webhook(late.secret).verify(hit!.body, hit!.headers);
      expect(payload).toMatchObject({
        id: eventId,
        type: 'test.stored',
        data: { amount: '10', reference: 'R-STORED' },
      });
      expect(hit!.body).not.toContain('FORGED');

      // Naming another tenant (RLS hides the row) or an unknown id delivers nothing.
      const other = await createTestTenant(t.app);
      const before = received.length;
      await expect(dispatcher.dispatch({ ...tampered, tenantId: other.tenantId })).resolves.toBe(
        'retry',
      );
      await expect(dispatcher.dispatch({ ...tampered, id: randomUUID() })).resolves.toBe('retry');
      expect(received.length).toBe(before);
    });

    it('retries a failing endpoint, never re-sends to one that succeeded, then dead-letters', async () => {
      const failing = await createEndpoint('/fail/always', ['test.failing']);
      const healthy = await createEndpoint('/ok/sibling', ['test.failing']);
      const eventId = await publish('test.failing', { n: 1 });

      const dead = await waitFor(async () => {
        const { Messages = [] } = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: dlqUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
          }),
        );
        return Messages.find((m) => (JSON.parse(m.Body ?? '{}') as { id?: string }).id === eventId);
      }, 'the message in the DLQ');
      expect(JSON.parse(dead.Body ?? '{}')).toMatchObject({
        id: eventId,
        tenantId: tenant.tenantId,
        type: 'test.failing',
      });

      const rows = await deliveries(eventId);
      const failed = rows.filter((r) => r.endpoint_id === failing.id);
      expect(failed.length).toBe(MAX_RECEIVES);
      expect(failed.map((r) => r.attempt)).toEqual([1, 2, 3]);
      expect(failed.every((r) => r.status === 'FAILED' && r.response_status === 500)).toBe(true);
      // The healthy endpoint got the event exactly once despite the redeliveries.
      const ok = rows.filter((r) => r.endpoint_id === healthy.id);
      expect(ok).toEqual([expect.objectContaining({ attempt: 1, status: 'SUCCEEDED' })]);
      expect(
        received.filter((r) => r.headers['webhook-id'] === eventId && r.path === '/ok/sibling'),
      ).toHaveLength(1);
    });
  });

  describe('auth events (out-of-band security notifications)', () => {
    it('delivers auth.account_locked to a subscribed lender endpoint', async () => {
      const endpoint = await createEndpoint('/ok/security', ['auth.account_locked']);
      const email = `locked-${randomUUID().slice(0, 8)}@${tenant.slug}.test`;
      const user = await api('post', '/v1/users', tenant.tokens.INSTITUTION_ADMIN)
        .send({ email, fullName: 'Locked Out', role: 'AUDITOR', password: STRONG_PASSWORD })
        .expect(201);
      for (let i = 0; i < 5; i++) {
        await request(t.http)
          .post('/v1/auth/login')
          .send({ institutionSlug: tenant.slug, email, password: 'Wrong-Password-123' });
      }

      const hit = await waitFor(
        () =>
          Promise.resolve(
            received.find(
              (r) => r.path === '/ok/security' && r.body.includes('"auth.account_locked"'),
            ),
          ),
        'the account_locked webhook',
      );
      const payload = new Webhook(endpoint.secret).verify(hit.body, hit.headers);
      expect(payload).toMatchObject({
        type: 'auth.account_locked',
        data: { userId: (user.body as { id: string }).id, lockedUntil: expect.any(String) },
      });
    });
  });

  describe('tenant directory', () => {
    it('projects a newly registered institution from its outbox event', async () => {
      const admin = await createPlatformAdmin(t.app);
      const token = t.app
        .get(TokenService)
        .issueAccessToken({ kind: 'PLATFORM_ADMIN', id: admin.id }).accessToken;
      const slug = `dir-${randomUUID().slice(0, 8)}`;
      const registered = await api('post', '/v1/platform/institutions', token)
        .send({
          slug,
          legalName: `${slug} Ltd`,
          countryCode: 'NG',
          defaultCurrency: 'NGN',
          supportedCurrencies: ['NGN'],
          lenderType: 'MICROFINANCE_BANK',
          homeRegion: env.CELL_REGION,
          branding: { displayName: 'Directory Test' },
          firstAdmin: {
            fullName: 'Ada Obi',
            email: `admin@${slug}.test`,
            password: STRONG_PASSWORD,
          },
        })
        .expect(201);

      const dynamo = new DynamoDBClient(aws);
      try {
        const item = await waitFor(async () => {
          const res = await dynamo.send(
            new GetItemCommand({ TableName: env.DIRECTORY_TABLE_NAME, Key: { slug: { S: slug } } }),
          );
          // Registration first reserves the slug with a PENDING row; the projection replaces it.
          return res.Item?.status?.S === 'ACTIVE' ? res.Item : undefined;
        }, 'the projected (ACTIVE) directory entry');
        expect(item.institutionId?.S).toBe((registered.body as { id: string }).id);
        expect(item.homeRegion?.S).toBe(env.CELL_REGION);
        expect(item.status?.S).toBe('ACTIVE');
      } finally {
        dynamo.destroy();
      }
    });

    it('logs directory.projection_conflict when another cell owns the slug', async () => {
      const admin = await createPlatformAdmin(t.app);
      const token = t.app
        .get(TokenService)
        .issueAccessToken({ kind: 'PLATFORM_ADMIN', id: admin.id }).accessToken;
      const slug = `clash-${randomUUID().slice(0, 8)}`;
      const { id } = (
        await api('post', '/v1/platform/institutions', token)
          .send({
            slug,
            legalName: `${slug} Ltd`,
            countryCode: 'NG',
            defaultCurrency: 'NGN',
            supportedCurrencies: ['NGN'],
            lenderType: 'MICROFINANCE_BANK',
            homeRegion: env.CELL_REGION,
            branding: { displayName: 'Clash Test' },
            firstAdmin: {
              fullName: 'Ada Obi',
              email: `admin@${slug}.test`,
              password: STRONG_PASSWORD,
            },
          })
          .expect(201)
      ).body as { id: string };
      const dynamo = new DynamoDBClient(aws);
      const warn = vi.spyOn(Logger.prototype, 'warn');
      try {
        await waitFor(async () => {
          const res = await dynamo.send(
            new GetItemCommand({ TableName: env.DIRECTORY_TABLE_NAME, Key: { slug: { S: slug } } }),
          );
          return res.Item?.status?.S === 'ACTIVE' ? res.Item : undefined;
        }, 'the projected entry');
        // Simulate another cell holding the slug at a newer version.
        await dynamo.send(
          new PutItemCommand({
            TableName: env.DIRECTORY_TABLE_NAME,
            Item: {
              slug: { S: slug },
              institutionId: { S: randomUUID() },
              homeRegion: { S: 'eu-west-3' },
              apiBaseUrl: { S: 'https://eu-west-3.api.example.com' },
              status: { S: 'ACTIVE' },
              version: { N: String(Date.now() * 1000 * 2) },
              updatedAt: { S: new Date().toISOString() },
            },
          }),
        );
        await api('patch', `/v1/platform/institutions/${id}/status`, token)
          .send({ status: 'SUSPENDED', reason: 'Projection conflict test' })
          .expect(200);

        const logged = await waitFor(
          () =>
            Promise.resolve(
              warn.mock.calls
                .map(([message]) => message as Record<string, unknown>)
                .find((m) => m.event === 'directory.projection_conflict' && m.slug === slug),
            ),
          'the conflict warning',
        );
        expect(logged).toMatchObject({
          institutionId: id,
          cellRegion: env.CELL_REGION,
        });
      } finally {
        warn.mockRestore();
        dynamo.destroy();
      }
    });
  });

  describe('end of day scheduling', () => {
    it('runs EOD once per tenant for its previous local business date', async () => {
      const scheduler = worker.app.get(EndOfDayScheduler);
      const redis = worker.app.get<Redis>(REDIS);
      // 12:00 UTC is past the 00:05 run time everywhere in Africa/Lagos.
      const now = new Date();
      now.setUTCHours(12, 0, 0, 0);
      // Close of day: the run at 13:00 Lagos time closes YESTERDAY's business date.
      const asOf = previousDate(localDateTime(now, 'Africa/Lagos').date);
      const doneKey = `eod:done:${tenant.tenantId}:${asOf}`;
      await redis.del(doneKey);

      const first = await scheduler.tick(now);
      expect(first.due).toBeGreaterThan(0);
      expect(await redis.exists(doneKey)).toBe(1);

      const second = await scheduler.tick(now);
      expect(second.ran).toBe(0);
      expect(second.skipped).toBe(second.due);
    });
  });
});
