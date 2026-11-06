package io.zooglass.access;

import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.time.Duration;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** A generated, test-only localhost certificate. Production TLS verification is unchanged. */
final class PolicyTlsFixture implements AutoCloseable {

    final SSLContext trust;
    final HttpsServer server;
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();

    PolicyTlsFixture(Path directory) throws Exception {
        Path store = directory.resolve("policy.p12");
        Path output = directory.resolve("keytool.log");
        var process = new ProcessBuilder(
                Path.of(System.getProperty("java.home"), "bin", "keytool").toString(),
                "-genkeypair", "-alias", "policy", "-keyalg", "EC", "-groupname", "secp256r1",
                "-keystore", store.toString(), "-storetype", "PKCS12",
                "-storepass", "test-password", "-dname", "CN=localhost",
                "-ext", "SAN=dns:localhost", "-validity", "2", "-noprompt")
                .redirectErrorStream(true).redirectOutput(output.toFile()).start();
        if (!process.waitFor(20, TimeUnit.SECONDS)) {
            process.destroyForcibly().waitFor();
            throw new IllegalStateException("Test key generation timed out");
        }
        if (process.exitValue() != 0) {
            throw new IllegalStateException(Files.readString(output));
        }
        var keys = KeyStore.getInstance("PKCS12");
        try (var input = Files.newInputStream(store)) {
            keys.load(input, "test-password".toCharArray());
        }
        var km = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        km.init(keys, "test-password".toCharArray());
        var tm = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tm.init(keys);
        trust = SSLContext.getInstance("TLS");
        trust.init(km.getKeyManagers(), tm.getTrustManagers(), null);
        server = HttpsServer.create(new InetSocketAddress("localhost", 0), 0);
        server.setHttpsConfigurator(new HttpsConfigurator(trust));
        server.setExecutor(executor);
        server.start();
    }

    PolicySettings settings(String path, Duration timeout, int capacity) {
        return new PolicySettings("tenant-a",
                URI.create("https://localhost:" + server.getAddress().getPort() + path),
                "service-secret", timeout, capacity);
    }

    void handle(String path, HttpHandler handler) {
        server.createContext(path, handler);
    }

    @Override
    public void close() {
        server.stop(0);
        executor.shutdownNow();
    }
}
