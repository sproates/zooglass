package io.zooglass;

import java.util.List;
import java.util.Map;

public record ViewConfiguration(List<ViewDefinition> views) {

    public record ViewDefinition(String id, Map<String, List<EventMatcher>> fields) {
    }

    public record EventMatcher(String sourceId, String type) {
    }
}
