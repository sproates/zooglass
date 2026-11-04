package io.zooglass;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.web.server.context.WebServerPortFileWriter;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class ZooGlassApplication {

    @Bean
    @ConditionalOnProperty(name = "zooglass.report-port", havingValue = "true")
    WebServerPortFileWriter boundPortFile() {
        return new WebServerPortFileWriter();
    }

    public static void main(String[] args) {
        SpringApplication.run(ZooGlassApplication.class, args);
    }
}
