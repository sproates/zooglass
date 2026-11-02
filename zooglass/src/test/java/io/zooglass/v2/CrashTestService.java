package io.zooglass.v2;

import io.zooglass.ZooGlassApplication;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

/** Runs the real service with test-only boundary instrumentation in a disposable JVM. */
public final class CrashTestService {
    private CrashTestService() {}

    public static void main(String[] args) throws Exception {
        Path directory = Path.of(args[0]);
        var driver = new CrashBoundaryDriver(CrashBoundaryDriver.Boundary.valueOf(args[1]));
        try (var context = new SpringApplicationBuilder(ZooGlassApplication.class).run(
                "--server.port=0",
                "--server.address=127.0.0.1",
                "--spring.main.banner-mode=off",
                "--zooglass.v2.config=" + directory.resolve("views.json").toUri(),
                "--zooglass.v2.database=" + directory.resolve("state.sqlite"));
                var commands = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            int port = ((WebServerApplicationContext) context).getWebServer().getPort();
            System.out.println("CRASH_READY " + port);
            System.out.flush();
            for (String command; (command = commands.readLine()) != null;) {
                if (!command.equals("ARM")) {
                    throw new IllegalArgumentException("Unknown test command");
                }
                driver.arm();
                System.out.println("CRASH_ARMED");
                System.out.flush();
            }
        }
    }
}
