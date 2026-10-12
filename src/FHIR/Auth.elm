port module FHIR.Auth exposing (Config, init, refresh, response)

import FHIR
import Json.Decode as Decode
import Json.Encode as Encode


type alias Config =
    { baseUri : String
    , clientId : String
    , redirectUri : String
    , scopes : List String
    , launch : Maybe String
    }


init : Config -> Cmd msg
init config =
    authCommand
        (Encode.object
            [ ( "type", Encode.string "init" )
            , ( "config"
              , Encode.object
                    [ ( "baseUri", Encode.string config.baseUri )
                    , ( "clientId", Encode.string config.clientId )
                    , ( "redirectUri", Encode.string config.redirectUri )
                    , ( "scopes", Encode.list Encode.string config.scopes )
                    , ( "launch", Maybe.map Encode.string config.launch |> Maybe.withDefault Encode.null )
                    ]
              )
            ]
        )


refresh : Cmd msg
refresh =
    authCommand (Encode.object [ ( "type", Encode.string "refresh" ) ])


response : (Result String FHIR.Client -> msg) -> Sub msg
response toMsg =
    authResponse
        (\value ->
            case Decode.decodeValue resultDecoder value of
                Ok result ->
                    toMsg result

                Err error ->
                    toMsg (Err (Decode.errorToString error))
        )


resultDecoder : Decode.Decoder (Result String FHIR.Client)
resultDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "ready" ->
                        Decode.field "client"
                            (Decode.map2 FHIR.Client
                                (Decode.field "baseUri" Decode.string)
                                (Decode.field "accessToken" Decode.string)
                            )
                            |> Decode.map Ok

                    "error" ->
                        Decode.field "message" Decode.string |> Decode.map Err

                    _ ->
                        Decode.fail "Unknown auth response."
            )


port authCommand : Encode.Value -> Cmd msg


port authResponse : (Decode.Value -> msg) -> Sub msg
