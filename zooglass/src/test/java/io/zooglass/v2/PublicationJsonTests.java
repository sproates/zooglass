package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PublicationJsonTests {
    private static final String VALID = """
            {"sourceId":"fleet","epoch":"one","sourceEntityId":"car",
             "publicationSequence":1,"type":"position","payload":{"x":1}}
            """;

    @ParameterizedTest
    @ValueSource(strings = {"0", "-1", "1.0", "1.2", "9007199254740992", "9223372036854775808", "null", "\"1\""})
    void rejectsInvalidPublicationSequences(String sequence) {
        assertThatThrownBy(() -> PublicationJson.parse(VALID.replace("\"publicationSequence\":1",
                "\"publicationSequence\":" + sequence))).isInstanceOf(RuntimeException.class);
    }

    @Test
    void rejectsMalformedAmbiguousAndUnsupportedEnvelopes() {
        for (String input : new String[] {"null", "[]", "{}", "{", VALID + " {}",
                VALID.replace("\"epoch\":\"one\"", "\"epoch\":\" \""),
                VALID.replace("\"payload\":{\"x\":1}", "\"payload\":[]"),
                VALID.replace("\"x\":1", "\"x\":1,\"x\":2"),
                VALID.replace("\"sourceId\":\"fleet\"", "\"sourceId\":3"),
                VALID.replace("\"type\":\"position\"", "\"type\":\"position\",\"operation\":\"retract\"")}) {
            assertThatThrownBy(() -> PublicationJson.parse(input)).as(input).isInstanceOf(RuntimeException.class);
        }
    }

    @Test
    void canonicalContentIgnoresObjectOrderAndNumericSpellingButPreservesTypesAndArrayOrder() {
        var left = IdentityFixtures.parse("fleet", "trip-1", "car", 1, "p", "{\"a\":1.00,\"b\":[true,null,2]}");
        var right = IdentityFixtures.parse("fleet", "trip-1", "car", 1, "p", "{\"b\":[true,null,2.0],\"a\":1}");
        assertThat(PublicationJson.content(left.payload())).isEqualTo(PublicationJson.content(right.payload()));
        for (String different : new String[] {"{\"a\":\"1\",\"b\":[true,null,2]}",
                "{\"a\":1,\"b\":[null,true,2]}", "{\"a\":1.0000000000000000001,\"b\":[true,null,2]}"}) {
            assertThat(PublicationJson.content(IdentityFixtures.parse("fleet", "trip-1", "car", 1, "p", different).payload()))
                    .isNotEqualTo(PublicationJson.content(left.payload()));
        }
        assertThat(PublicationJson.parse(VALID.replace("\"publicationSequence\":1", "\"publicationSequence\":9007199254740991"))
                .publicationSequence()).isEqualTo(PublicationJson.MAX_SEQUENCE);
    }
}
