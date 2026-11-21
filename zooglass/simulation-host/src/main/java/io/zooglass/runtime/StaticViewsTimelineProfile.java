package io.zooglass.runtime;

import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeMap;

/** Explicit bounded family, checked only after production configuration validation. */
public final class StaticViewsTimelineProfile {
    public static final String NAME = "memory-static-views-v1";
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private StaticViewsTimelineProfile() {}

    public record Issue(String path, String rule) {}

    public static List<Issue> inspect(RuntimeConfiguration config) {
        return inspect(config, false);
    }

    static List<Issue> inspect(RuntimeConfiguration config, boolean recovery) {
        var issues = new ArrayList<Issue>();
        require(issues, "$.storage", recovery ? "memory or sqlite storage required" : "memory storage required",
                "memory".equals(config.storage()) || (recovery && "sqlite".equals(config.storage())));
        require(issues, "$.sources", "one to three sources required",
                !config.sources().isEmpty() && config.sources().size() <= 3);
        require(issues, "$.views", "one to two views required",
                !config.views().isEmpty() && config.views().size() <= 2);
        require(issues, "$.views", "at most four fields in total",
                config.views().stream().mapToInt(view -> view.fields().size()).sum() <= 4);
        require(issues, "$.maxStreams", "at most 20 streams", config.maxStreams() <= 20);
        require(issues, "$.identityWindow", "at most 20 sequence positions", config.identityWindow() <= 20);
        require(issues, "$.maxHistoryEntries", "at most 20 history entries", config.maxHistoryEntries() <= 20);
        require(issues, "$.delivery.maxQueuedMessages", "at most 128 messages",
                config.delivery().maxQueuedMessages() <= 128);
        require(issues, "$.delivery.maxQueuedBytes", "at most 1048576 bytes",
                config.delivery().maxQueuedBytes() <= 1_048_576);
        for (int i = 0; i < config.sources().size(); i++)
            require(issues, "$.sources[" + i + "].progress.mode", "untracked progress required",
                    "untracked".equals(config.sources().get(i).progress().mode()));
        for (int i = 0; i < config.views().size(); i++) {
            var view = config.views().get(i);
            String path = "$.views[" + i + "]";
            require(issues, path + ".fields", "one to three fields per view required",
                    !view.fields().isEmpty() && view.fields().size() <= 3);
            require(issues, path + ".publication.mode", "publishPartial required",
                    "publishPartial".equals(view.publication().mode()));
            new TreeMap<>(view.entities()).forEach((source, entity) ->
                    require(issues, member(path + ".entities", source) + ".mode", "envelopeEntity required",
                            "envelopeEntity".equals(entity.mode())));
            view.fields().forEach((name, field) -> field(issues, member(path + ".fields", name), field));
        }
        return List.copyOf(issues);
    }

    private static void field(List<Issue> issues, String path, RuntimeConfiguration.Field field) {
        require(issues, path + ".mode", "arrival, latestBySequence or historyBySequence required",
                Set.of("arrival", "latestBySequence", "historyBySequence").contains(field.mode()));
        var inputs = field.allInputs();
        require(issues, path + ".inputs", "one or two distinct event types from one source required",
                inputs.size() >= 1 && inputs.size() <= 2
                        && inputs.stream().map(RuntimeConfiguration.Input::sourceId).distinct().count() == 1
                        && inputs.stream().map(RuntimeConfiguration.Input::type).distinct().count() == inputs.size());
        require(issues, path + ".conflict", "no conflict policy", field.conflict() == null);
        require(issues, path + ".late.mode", "acceptLate required", "acceptLate".equals(field.late().mode()));
        require(issues, path + ".freshness.mode", "unspecified freshness required",
                "unspecified".equals(field.freshness().mode()));
        require(issues, path + ".facts", "no fact policy", field.facts() == null);
        require(issues, path + ".property", "no property aggregation", field.property() == null);
    }

    private static void require(List<Issue> issues, String path, String rule, boolean matches) {
        if (!matches) issues.add(new Issue(path, rule));
    }

    /** JSON string escaping keeps arbitrary configured names unambiguous in bracket paths. */
    private static String member(String path, String name) {
        return path + "[" + JSON.writeValueAsString(name) + "]";
    }
}
