package io.zooglass.runtime;

import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.MapperFeature;
import tools.jackson.databind.cfg.CoercionAction;
import tools.jackson.databind.cfg.CoercionInputShape;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.type.LogicalType;

import java.util.List;

/** Strict JSON encoding shared by durable state backends. */
final class StateRowJson {
    private StateRowJson() {}

    static final JsonMapper JSON =
            JsonMapper.builder(StoredJson.rowFactory())
                    .withCoercionConfig(
                            LogicalType.Textual,
                            coercion -> {
                                for (var shape :
                                        List.of(
                                                CoercionInputShape.Integer,
                                                CoercionInputShape.Float,
                                                CoercionInputShape.Boolean)) {
                                    coercion.setCoercion(shape, CoercionAction.Fail);
                                }
                            })
                    .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                    .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
                    .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
                    .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
                    .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                    .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .build();
}
