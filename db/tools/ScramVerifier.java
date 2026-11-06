import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Prints one PostgreSQL SCRAM-SHA-256 password verifier per argument, each computed from the
 * environment variable the argument names (RFC 5802 / RFC 7677, PostgreSQL's
 * {@code SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>} format).
 *
 * <p>Used by db/docker-entrypoint.sh so that CREATE/ALTER ROLE receives a verifier, never the
 * plaintext password. The password is read from the environment (never argv); the verifier is
 * handed to the migration session out of band (see db/callbacks/beforeMigrate.sql).
 *
 * <p>Iterations: 100,000 instead of PostgreSQL's default 4096, i.e. a leaked verifier costs
 * about 24x more to attack offline. In SCRAM the SERVER never runs PBKDF2 at login (it stores
 * StoredKey/ServerKey and checks an HMAC proof); the CLIENT derives the salted password once
 * per new connection: about 8 ms per connection at 100,000 (measured in Node: 4096 = 0.5 ms,
 * 100,000 = 7.9 ms, 600,000 = 47 ms). The API and worker hold pooled connections, so this is
 * paid at pool fill, not per request.
 *
 * <p>Why not OWASP's 600,000: node-postgres (the API and worker driver) refuses servers that
 * demand more than its {@code scramMaxIterations} guard, 100,000 by default, which protects
 * clients from a hostile server burning their CPU. Going higher would mean raising that guard
 * in every client. The runtime passwords are long random secrets (Secrets Manager), so the
 * iteration count is defence in depth, not the main protection.
 *
 * <p>Passwords must be printable ASCII. PostgreSQL applies SASLprep (RFC 4013) before hashing;
 * for printable ASCII that is the identity, so this verifier matches what the server derives
 * at login. Anything else is refused rather than risking a verifier no login can match.
 */
public final class ScramVerifier {
  private static final int ITERATIONS = 100_000;
  private static final int SALT_BYTES = 16;
  private static final int KEY_BITS = 256;

  private ScramVerifier() {}

  public static void main(String[] args) throws Exception {
    if (args.length == 0) {
      fail("usage: ScramVerifier <ENV_VAR>...");
    }
    StringBuilder out = new StringBuilder();
    for (String name : args) {
      out.append(verifier(name, password(name))).append('\n');
    }
    System.out.print(out);
  }

  private static String password(String name) {
    String value = System.getenv(name);
    if (value == null || value.isEmpty()) {
      fail(name + " is required");
    }
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (c < 0x20 || c > 0x7e) {
        fail(name + " must be printable ASCII (PostgreSQL SASLprep would alter it)");
      }
    }
    return value;
  }

  private static String verifier(String name, String password) throws Exception {
    byte[] salt = new byte[SALT_BYTES];
    new SecureRandom().nextBytes(salt);
    byte[] salted =
        SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            .generateSecret(new PBEKeySpec(password.toCharArray(), salt, ITERATIONS, KEY_BITS))
            .getEncoded();
    byte[] storedKey = MessageDigest.getInstance("SHA-256").digest(hmac(salted, "Client Key"));
    byte[] serverKey = hmac(salted, "Server Key");
    Base64.Encoder b64 = Base64.getEncoder();
    return "SCRAM-SHA-256$" + ITERATIONS + ":" + b64.encodeToString(salt) + "$"
        + b64.encodeToString(storedKey) + ":" + b64.encodeToString(serverKey);
  }

  private static byte[] hmac(byte[] key, String message) throws Exception {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(key, "HmacSHA256"));
    return mac.doFinal(message.getBytes(StandardCharsets.US_ASCII));
  }

  private static void fail(String message) {
    System.err.println("[db-migrate] " + message);
    System.exit(64);
  }
}
