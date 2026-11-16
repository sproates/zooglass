package io.zooglass.runtime;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.DatabindException;
import tools.jackson.databind.JsonNode;

/** Read-only access to the same decoder and validation used by service startup. */
public final class ConfigurationInspection {
    private ConfigurationInspection() {}

    public record Diagnostic(String code, String path, String reason, Integer line, Integer column) {}

    public record Result(
            RuntimeConfiguration configuration, JsonNode declared, Diagnostic diagnostic) {
        public boolean valid() {
            return configuration != null;
        }
    }

    public static Result inspect(String json) {
        var mapper = RuntimeConfiguration.configurationMapper();
        try {
            var declared = mapper.readTree(json);
            var configuration = RuntimeConfiguration.decode(mapper, declared);
            configuration.validate();
            return new Result(configuration, declared, null);
        } catch (DatabindException failure) {
            StringBuilder path = new StringBuilder();
            for (var reference : failure.getPath()) {
                if (reference.getPropertyName() != null) {
                    path.append('/').append(pointerToken(reference.getPropertyName()));
                } else if (reference.getIndex() >= 0) {
                    path.append('/').append(reference.getIndex());
                }
            }
            return invalid("invalid-value", path.toString(),
                    "Value, property or constructor settings are not valid for runtime configuration",
                    null, null);
        } catch (JacksonException failure) {
            var location = failure.getLocation();
            return invalid("invalid-json", "", "Invalid JSON syntax, duplicate key or parser limit",
                    location == null ? null : location.getLineNr(),
                    location == null ? null : location.getColumnNr());
        } catch (IllegalArgumentException failure) {
            // Production validators use static reasons, never source values. Do not expose
            // Jackson exception messages: they can contain the input document and values.
            return invalid("invalid-configuration", "", failure.getMessage(), null, null);
        } catch (NullPointerException failure) {
            return invalid("invalid-configuration", "", "Missing or null configuration value", null, null);
        }
    }

    private static Result invalid(String code, String path, String reason, Integer line, Integer column) {
        return new Result(null, null, new Diagnostic(code, path, reason, line, column));
    }

    public static String pointerToken(String value) {
        return value.replace("~", "~0").replace("/", "~1");
    }
}
