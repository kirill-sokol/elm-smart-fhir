port module AuthBridgeHarness exposing (main)

import FHIR
import FHIR.Auth
import Json.Encode as Encode
import Platform


port initialize : (FHIR.Auth.Config -> msg) -> Sub msg


port refreshSession : (() -> msg) -> Sub msg


port observedResponse : Encode.Value -> Cmd msg


type Msg
    = Initialize FHIR.Auth.Config
    | Refresh
    | Response (Result String FHIR.Client)


main : Program () () Msg
main =
    Platform.worker
        { init = \_ -> ( (), Cmd.none )
        , update =
            \msg model ->
                case msg of
                    Initialize config ->
                        ( model, FHIR.Auth.init config )

                    Refresh ->
                        ( model, FHIR.Auth.refresh )

                    Response result ->
                        ( model
                        , observedResponse
                            (case result of
                                Ok client ->
                                    Encode.object
                                        [ ( "client"
                                          , Encode.object
                                                [ ( "baseUri", Encode.string client.baseUri )
                                                , ( "accessToken", Encode.string client.accessToken )
                                                ]
                                          )
                                        ]

                                Err error ->
                                    Encode.object [ ( "error", Encode.string error ) ]
                            )
                        )
        , subscriptions =
            \_ ->
                Sub.batch
                    [ initialize Initialize
                    , refreshSession (always Refresh)
                    , FHIR.Auth.response Response
                    ]
        }
