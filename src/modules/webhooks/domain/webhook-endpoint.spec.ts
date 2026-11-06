import { auditableWebhookUrl, toEndpointAuditView } from './webhook-endpoint';

describe('webhook URLs in the audit log', () => {
  it('keeps origin and path only (no query string, no fragment)', () => {
    expect(auditableWebhookUrl('https://hooks.example.com/in/10mg?token=s3cr3t&x=1#frag')).toBe(
      'https://hooks.example.com/in/10mg',
    );
    expect(auditableWebhookUrl('https://hooks.example.com:8443/?k=v')).toBe(
      'https://hooks.example.com:8443/',
    );
    expect(auditableWebhookUrl('not a url?token=x')).toBe('[INVALID_URL]');
  });

  it('rewrites only the url of an endpoint view', () => {
    const view = {
      id: 'e-1',
      url: 'https://hooks.example.com/a?sig=abc',
      eventTypes: ['loan.disbursed'],
      status: 'ACTIVE' as const,
      createdAt: '2026-11-06T00:00:00.000Z',
      updatedAt: '2026-11-06T00:00:00.000Z',
    };
    expect(toEndpointAuditView(view)).toEqual({ ...view, url: 'https://hooks.example.com/a' });
  });
});
