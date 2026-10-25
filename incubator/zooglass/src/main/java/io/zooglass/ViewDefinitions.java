package io.zooglass;

import tools.jackson.databind.ObjectMapper;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;
import java.io.IOException;
import java.util.HashSet;
import java.util.Set;
import java.util.List;
import java.util.Map;

/** Configuration loading and validation; owns no registered views or entity state. */
final class ViewDefinitions {
    private ViewDefinitions() {}

    static void validateConfiguration(ViewConfiguration configuration) {
        if (configuration == null || configuration.views() == null) {
            throw new IllegalStateException("View configuration must contain a views array.");
        }

        Set<String> viewIds = new HashSet<>();
        for (ViewConfiguration.ViewDefinition view : configuration.views()) {
            if (view == null) {
                throw new IllegalStateException("View configuration contains an empty view definition.");
            }
            try {
                validate(view);
            } catch (IllegalArgumentException exception) {
                throw new IllegalStateException(exception.getMessage(), exception);
            }
            if (!viewIds.add(view.id())) {
                throw new IllegalStateException("View id is configured more than once: " + view.id());
            }
        }
    }

    static void validate(ViewConfiguration.ViewDefinition view) {
        if (view == null) {
            throw new IllegalArgumentException("View definition must be a JSON object.");
        }
        validateName(view.id(), "view id");
        if (view.fields() == null || view.fields().isEmpty()) {
            throw new IllegalArgumentException("View " + view.id() + " must define at least one field.");
        }

        for (Map.Entry<String, List<ViewConfiguration.EventMatcher>> field : view.fields().entrySet()) {
            validateName(field.getKey(), "field name in view " + view.id());
            if (field.getValue() == null || field.getValue().isEmpty()) {
                throw new IllegalArgumentException("View field " + field.getKey() + " must define at least one event matcher.");
            }
            for (ViewConfiguration.EventMatcher matcher : field.getValue()) {
                if (matcher == null) {
                    throw new IllegalArgumentException("View field " + field.getKey() + " has an empty event matcher.");
                }
                validateName(matcher.sourceId(), "sourceId for " + view.id() + "." + field.getKey());
                validateName(matcher.type(), "type for " + view.id() + "." + field.getKey());
            }
        }

        if (view.ordering() != null) {
            for (Map.Entry<String, ViewConfiguration.Ordering> entry : view.ordering().entrySet()) {
                if (!view.fields().containsKey(entry.getKey())) {
                    throw new IllegalArgumentException("Ordering is configured for unknown view field "
                            + entry.getKey() + " in view " + view.id() + ".");
                }
                ViewConfiguration.Ordering ordering = entry.getValue();
                if (ordering == null || !("latestBySequence".equals(ordering.mode())
                        || "historyBySequence".equals(ordering.mode()))) {
                    throw new IllegalArgumentException("View " + view.id() + " has an unsupported ordering mode.");
                }
                validateName(ordering.sequenceField(), "sequenceField for " + view.id() + "." + entry.getKey());
            }
        }
    }

    static ViewConfiguration load(
            ObjectMapper objectMapper,
            ResourceLoader resourceLoader,
            String configLocation) {
        Resource resource = resourceLoader.getResource(configLocation);
        ViewConfiguration configuration;
        try (var input = resource.getInputStream()) {
            configuration = objectMapper.readValue(input, ViewConfiguration.class);
        } catch (IOException exception) {
            throw new IllegalStateException("Could not load view configuration from " + configLocation, exception);
        }

        return configuration;
    }

    private static void validateName(String value, String label) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("View configuration requires a non-empty " + label + ".");
        }
    }
}
