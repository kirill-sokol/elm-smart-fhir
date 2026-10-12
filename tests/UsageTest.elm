module UsageTest exposing (tests)

import Expect
import FHIR
import FHIR.Search.Patient
import Http
import Test exposing (Test, describe, test)


tests : Test
tests =
    describe "Patient search request"
        [ test "search by given and family" <|
            \_ ->
                let
                    defaults =
                        FHIR.Search.Patient.default

                    params =
                        { defaults | given = [ "Jane" ], family = [ "Doe" ] }

                    request : FHIR.Request FHIR.Bundle
                    request =
                        FHIR.search (FHIR.Patient params)
                in
                Expect.equal
                    ( "GET", "Patient?given=Jane&family=Doe" )
                    ( request.method, request.url )
        , test "empty lists omit query parameters" <|
            \_ ->
                FHIR.search (FHIR.Patient FHIR.Search.Patient.default)
                    |> .url
                    |> Expect.equal "Patient"
        , test "values are URL encoded and lists repeat parameters" <|
            \_ ->
                let
                    defaults =
                        FHIR.Search.Patient.default

                    params =
                        { defaults
                            | given = [ "Jane Ann", "Zoë" ]
                            , family = [ "Müller" ]
                        }
                in
                FHIR.search (FHIR.Patient params)
                    |> .url
                    |> Expect.equal "Patient?given=Jane%20Ann&given=Zo%C3%AB&family=M%C3%BCller"
        , test "uses the client's access token and base URI" <|
            \_ ->
                let
                    client =
                        { baseUri = "https://example.test/fhir/"
                        , accessToken = "test-access-token"
                        }

                    request =
                        FHIR.search (FHIR.Patient FHIR.Search.Patient.default)
                            |> FHIR.prepare client
                in
                Expect.all
                    [ .headers
                        >> Expect.equal
                            [ Http.header "Authorization" "Bearer test-access-token"
                            , Http.header "Accept" "application/fhir+json"
                            ]
                    , .url >> Expect.equal "https://example.test/fhir/Patient"
                    ]
                    request
        ]
