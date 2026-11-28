package io.zooglass.logging;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.AppenderBase;

import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/** Isolated real logger for controlled time, blocked sinks and boundary assertions. */
public final class ViewerLogCapture implements AutoCloseable {
    private final LoggerContext context = new LoggerContext();
    public final Logger logger = context.getLogger("viewer-test");
    public final AtomicLong now = new AtomicLong();
    public final OperationalLog operations = new OperationalLog(logger, "owned", now::get);
    public final LinkedBlockingQueue<ILoggingEvent> records = new LinkedBlockingQueue<>();

    public ViewerLogCapture() {
        this(ignored -> {});
    }

    public ViewerLogCapture(Consumer<ILoggingEvent> sink) {
        logger.setLevel(Level.DEBUG);
        var appender = new AppenderBase<ILoggingEvent>() {
            @Override
            protected void append(ILoggingEvent event) {
                sink.accept(event);
                records.add(event);
            }
        };
        appender.start();
        logger.addAppender(appender);
    }

    public Map<String, Object> next(String event) throws InterruptedException {
        var record = records.poll(5, TimeUnit.SECONDS);
        assertThat(record).as(event).isNotNull();
        assertThat(record.getThrowableProxy()).isNull();
        var fields = fields(record);
        assertThat(fields).containsEntry("event", event).containsEntry("instanceId", "owned");
        assertThat(record.getFormattedMessage() + fields).hasSizeLessThan(512).doesNotContain("SENTINEL");
        return fields;
    }

    public static Map<String, Object> fields(ILoggingEvent record) {
        return record.getKeyValuePairs().stream().collect(Collectors.toMap(p -> p.key, p -> p.value));
    }

    @Override
    public void close() {
        operations.viewers().close();
        context.stop();
    }
}
