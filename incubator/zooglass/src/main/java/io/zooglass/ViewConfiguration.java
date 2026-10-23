package io.zooglass;

import java.util.List;
import java.util.Map;

public record ViewConfiguration(List<ViewDefinition> views) {

    public record ViewDefinition(
            String id,
            Map<String, List<EventMatcher>> fields,
            Map<String, Ordering> ordering) {
        public ViewDefinition(String id, Map<String, List<EventMatcher>> fields) {
            this(id, fields, null);
        }
    }

    public record EventMatcher(String sourceId, String type) {
    }

    public record Ordering(String mode, String sequenceField) {
    }
}
