package io.zooglass;

import io.zooglass.logging.OperationalLog;
import io.zooglass.logging.ServiceLifecycle;
import io.zooglass.runtime.StoreAdoption;
import io.zooglass.config.ConfigurationCommand;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.web.server.context.WebServerPortFileWriter;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
@org.springframework.web.socket.config.annotation.EnableWebSocket
public class ZooGlassApplication {

    @org.springframework.beans.factory.annotation.Autowired
    void checkDeployment(org.springframework.core.env.Environment environment) {
        var profile = environment.getProperty("zooglass.deployment.profile", "standalone");
        if ("standalone".equals(profile) && org.springframework.boot.context.properties.bind.Binder.get(environment)
                .bind("zooglass.ha", org.springframework.boot.context.properties.bind.Bindable.mapOf(String.class, String.class)).isBound()) {
            throw new IllegalArgumentException("HA settings require an explicit HA deployment profile");
        }
        if (!java.util.Set.of("standalone", "ha-static-v1").contains(profile)) {
            throw new IllegalArgumentException("Unknown ZooGlass deployment profile");
        }
    }

    @Bean
    @ConditionalOnProperty(name = "zooglass.report-port", havingValue = "true")
    WebServerPortFileWriter boundPortFile() {
        return new WebServerPortFileWriter();
    }

    @Bean
    @ConditionalOnMissingBean(OperationalLog.class)
    OperationalLog operationalLog() {
        return OperationalLog.forService();
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
        var operations = OperationalLog.forService();
        var service = new SpringApplication(ZooGlassApplication.class);
        service.addInitializers(context ->
                context.getBeanFactory().registerSingleton("serviceOperationalLog", operations));
        service.addListeners(new ServiceLifecycle.StartupFailureListener(operations));
        service.run(args);
    }
}
