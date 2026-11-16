package io.zooglass;

import io.zooglass.runtime.StoreAdoption;
import io.zooglass.config.ConfigurationCommand;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.web.server.context.WebServerPortFileWriter;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
@org.springframework.web.socket.config.annotation.EnableWebSocket
public class ZooGlassApplication {

    @Bean
    @ConditionalOnProperty(name = "zooglass.report-port", havingValue = "true")
    WebServerPortFileWriter boundPortFile() {
        return new WebServerPortFileWriter();
    }

    public static void main(String[] args) {
        if (args.length > 0 && "config".equals(args[0])) {
            System.exit(ConfigurationCommand.run(args, System.out));
            return;
        }
        if (args.length > 0 && "adopt-store".equals(args[0])) {
            StoreAdoption.run(args);
            return;
        }
        SpringApplication.run(ZooGlassApplication.class, args);
    }
}
