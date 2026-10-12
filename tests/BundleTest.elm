module BundleTest exposing (tests)

import Expect
import FHIR
import FHIR.Resource
import Json.Decode
import Test exposing (Test, describe, test)


tests : Test
tests =
    describe "Real FHIR Bundle decoding"
        [ test "preserves mixed resources from includes" <|
            \_ ->
                Json.Decode.decodeString FHIR.bundleDecoder
                    """{"resourceType":"Bundle","total":1,"entry":[{"resource":{"resourceType":"Patient","id":"p1"}},{"resource":{"resourceType":"Condition","id":"c1"}},{"resource":{"resourceType":"Practitioner","id":"pr1"}}]}"""
                    |> Result.map
                        (\bundle ->
                            ( bundle.total
                            , List.map
                                (\entry ->
                                    case entry.resource of
                                        FHIR.Resource.Patient _ ->
                                            "Patient"

                                        FHIR.Resource.Condition _ ->
                                            "Condition"

                                        FHIR.Resource.Other resourceType _ ->
                                            resourceType
                                )
                                bundle.entry
                            )
                        )
                    |> Expect.equal (Ok ( Just 1, [ "Patient", "Condition", "Practitioner" ] ))
        , test "an empty bundle can omit total and entry" <|
            \_ ->
                Json.Decode.decodeString FHIR.bundleDecoder """{"resourceType":"Bundle"}"""
                    |> Expect.equal (Ok { total = Nothing, entry = [] })
        , test "rejects an OperationOutcome instead of treating it as an empty bundle" <|
            \_ ->
                case Json.Decode.decodeString FHIR.bundleDecoder """{"resourceType":"OperationOutcome","issue":[]}""" of
                    Err _ ->
                        Expect.pass

                    Ok _ ->
                        Expect.fail "Expected a decoding error."
        , test "rejects malformed entries instead of silently omitting them" <|
            \_ ->
                case Json.Decode.decodeString FHIR.bundleDecoder """{"resourceType":"Bundle","entry":[{"resource":{}}]}""" of
                    Err _ ->
                        Expect.pass

                    Ok _ ->
                        Expect.fail "Expected a decoding error."
        ]
