package io.zooglass.logging;

import io.zooglass.access.AdmissionAccess;
import io.zooglass.runtime.ViewCoordinator;

import org.springframework.boot.context.event.ApplicationFailedEvent;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationContext;
import org.springframework.context.ApplicationListener;
import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.concurrent.atomic.AtomicBoolean;

/** Runtime readiness and context closure belong to the owning service context only. */
@Component
public final class ServiceLifecycle {
    private final OperationalLog log;
    private final ApplicationContext owner;
    private final ViewCoordinator runtime;
    private final AdmissionAccess access;
    private final AtomicBoolean ready = new AtomicBoolean();

    public ServiceLifecycle(OperationalLog log, ApplicationContext owner, ViewCoordinator runtime, AdmissionAccess access) {
        this.log = log;
        this.owner = owner;
        this.runtime = runtime;
        this.access = access;
    }

    @EventListener
    public void ready(ApplicationReadyEvent event) {
        if (event.getApplicationContext() == owner && ready.compareAndSet(false, true)) {
            log.ready(runtime.operatingModes(access.protectedMode()));
        }
    }

    @EventListener
    public void closing(ContextClosedEvent event) {
        if (event.getApplicationContext() == owner && ready.compareAndSet(true, false)) {
            log.stopping();
        }
    }

    /** Installed before run(), so failure can be reported even when beans could not be created. */
    public record StartupFailureListener(OperationalLog log) implements ApplicationListener<ApplicationFailedEvent> {
        @Override
        public void onApplicationEvent(ApplicationFailedEvent event) {
            log.startFailed();
        }
    }
}
