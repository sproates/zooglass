package io.zooglass.delivery;

import io.zooglass.runtime.RuntimeConfiguration.Delivery;

import org.springframework.web.socket.TextMessage;

import java.util.LinkedHashMap;
import java.util.List;

/** Only waiting frames consume budget. A take transfers ownership to the socket writer. */
final class OutboundQueue {
    enum Admission {
        ACCEPTED,
        FULL,
        TOO_LARGE
    }

    private record Frame(TextMessage message, int bytes) {
        Frame(TextMessage message) {
            this(message, message.getPayloadLength());
        }
    }

    private final Delivery settings;
    private final LinkedHashMap<Object, Frame> waiting = new LinkedHashMap<>();
    private long bytes;
    private boolean stopped;

    OutboundQueue(Delivery settings) {
        this.settings = settings;
    }

    synchronized Admission offerUpdate(long generation, TextMessage message) {
        var key = settings.slowClient().keyForUpdate(generation);
        var frame = new Frame(message);
        var previous = waiting.get(key);
        long retainedBytes = bytes - (previous == null ? 0 : previous.bytes());
        int retainedCount = waiting.size() - (previous == null ? 0 : 1);
        var admission = check(retainedCount, retainedBytes, 1, frame.bytes());
        if (admission == Admission.ACCEPTED) {
            waiting.putLast(key, frame);
            bytes = retainedBytes + frame.bytes();
            notifyAll();
        }
        return admission;
    }

    /** Acknowledgements, errors and opening baselines always keep their own slots. */
    synchronized Admission offerProtected(List<TextMessage> messages) {
        var frames = messages.stream().map(Frame::new).toList();
        long batchBytes = frames.stream().mapToLong(Frame::bytes).sum();
        var admission = check(waiting.size(), bytes, frames.size(), batchBytes);
        if (admission == Admission.ACCEPTED) {
            for (var frame : frames) {
                waiting.put(new Object(), frame);
            }
            bytes += batchBytes;
            notifyAll();
        }
        return admission;
    }

    private Admission check(int count, long retainedBytes, int added, long addedBytes) {
        if (addedBytes > settings.maxQueuedBytes()) {
            return Admission.TOO_LARGE;
        }
        if (stopped
                || added > settings.maxQueuedMessages() - count
                || addedBytes > settings.maxQueuedBytes() - retainedBytes) {
            return Admission.FULL;
        }
        return Admission.ACCEPTED;
    }

    synchronized TextMessage take() throws InterruptedException {
        while (waiting.isEmpty() && !stopped) {
            wait();
        }
        if (stopped) {
            return null;
        }
        var frame = waiting.pollFirstEntry().getValue();
        bytes -= frame.bytes();
        return frame.message();
    }

    synchronized void stop() {
        stopped = true;
        waiting.clear();
        bytes = 0;
        notifyAll();
    }
}
