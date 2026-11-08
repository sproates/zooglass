package io.zooglass.access;

import jakarta.servlet.ServletException;
import org.apache.catalina.connector.Connector;
import org.apache.catalina.connector.Request;
import org.apache.catalina.connector.Response;
import org.apache.catalina.valves.ValveBase;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.stereotype.Component;

import java.io.IOException;

/** Marks requests by connector identity, not by a port or forwarding header supplied by a caller. */
@Component
public final class OperatorListener implements WebServerFactoryCustomizer<TomcatServletWebServerFactory> {
    private final OperatorAccess operator;

    public OperatorListener(OperatorAccess operator) { this.operator = operator; }

    @Override
    public void customize(TomcatServletWebServerFactory factory) {
        if (!operator.enabled()) return;
        var connector = new Connector("org.apache.coyote.http11.Http11NioProtocol");
        connector.setPort(operator.port());
        connector.setProperty("address", "127.0.0.1");
        factory.addAdditionalConnectors(connector);
        factory.addContextValves(new ValveBase(true) {
            @Override
            public void invoke(Request request, Response response) throws IOException, ServletException {
                if (request.getConnector() == connector) request.setAttribute(OperatorAccess.LISTENER, operator);
                getNext().invoke(request, response);
            }
        });
    }
}
