port module LiveTest exposing (main)

import Browser
import FHIR
import FHIR.Auth
import FHIR.Resource
import FHIR.Search.Patient
import Html exposing (Html, a, button, code, div, h1, h2, input, label, li, p, pre, text, ul)
import Html.Attributes exposing (disabled, href, placeholder, rel, target, value)
import Html.Events exposing (onClick, onInput)
import Http
import Json.Encode


port start : (() -> msg) -> Sub msg


type alias Model =
    { redirectUri : String
    , canConnect : Bool
    , client : Maybe FHIR.Client
    , given : String
    , family : String
    , status : String
    , busy : Bool
    , requestUrl : String
    , bundle : Maybe FHIR.Bundle
    }


type Msg
    = Connect
    | GotAuth (Result String FHIR.Client)
    | Refresh
    | GivenChanged String
    | FamilyChanged String
    | Search
    | GotBundle (Result Http.Error FHIR.Bundle)


main : Program { redirectUri : String, canConnect : Bool } Model Msg
main =
    Browser.element
        { init =
            \flags ->
                ( { redirectUri = flags.redirectUri
                  , canConnect = flags.canConnect
                  , client = Nothing
                  , given = ""
                  , family = ""
                  , status = "Launch this page from the SMART sandbox to connect."
                  , busy = False
                  , requestUrl = ""
                  , bundle = Nothing
                  }
                , Cmd.none
                )
        , update = update
        , subscriptions = \_ -> Sub.batch [ start (always Connect), FHIR.Auth.response GotAuth ]
        , view = view
        }


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        Connect ->
            ( { model | busy = True, status = "Connecting…" }
            , FHIR.Auth.init
                { baseUri = ""
                , clientId = "elm-fhir-live-test"
                , redirectUri = model.redirectUri
                , scopes = [ "launch", "patient/Patient.rs", "offline_access" ]
                , launch = Nothing
                }
            )

        GotAuth (Ok client) ->
            ( { model | client = Just client, busy = False, status = "Connected. Search patients or refresh the token." }, Cmd.none )

        GotAuth (Err error) ->
            ( { model | busy = False, status = "Auth error: " ++ error }, Cmd.none )

        Refresh ->
            ( { model | busy = True, status = "Refreshing token…" }, FHIR.Auth.refresh )

        GivenChanged given ->
            ( { model | given = given }, Cmd.none )

        FamilyChanged family ->
            ( { model | family = family }, Cmd.none )

        Search ->
            case model.client of
                Nothing ->
                    ( model, Cmd.none )

                Just client ->
                    let
                        defaults =
                            FHIR.Search.Patient.default

                        params =
                            { defaults | given = nonempty model.given, family = nonempty model.family }

                        request =
                            FHIR.search (FHIR.Patient params)
                                |> FHIR.prepare client
                    in
                    ( { model | busy = True, status = "Searching…", requestUrl = request.url, bundle = Nothing }
                    , Http.request { request | timeout = Just 15000 } |> Cmd.map GotBundle
                    )

        GotBundle (Ok bundle) ->
            ( { model | busy = False, status = "Search succeeded.", bundle = Just bundle }, Cmd.none )

        GotBundle (Err error) ->
            ( { model | busy = False, status = httpError error }, Cmd.none )


nonempty : String -> List String
nonempty value_ =
    if String.isEmpty (String.trim value_) then
        []

    else
        [ String.trim value_ ]


view : Model -> Html Msg
view model =
    div []
        [ h1 [] [ text "Elm SMART live test" ]
        , p [] [ text "In the launcher: choose FHIR R4 and Provider EHR Launch. Paste this page’s address as the launch URL, select a test patient, then launch." ]
        , p [] [ code [] [ text model.redirectUri ] ]
        , a [ href "https://launch.smarthealthit.org/", target "_blank", rel "noopener noreferrer" ] [ text "Open SMART App Launcher" ]
        , h2 [] [ text "Connection" ]
        , p [] [ text model.status ]
        , p [] [ text (Maybe.map .baseUri model.client |> Maybe.withDefault "") ]
        , button [ onClick Connect, disabled (model.busy || not model.canConnect) ] [ text "Connect / restore session" ]
        , button [ onClick Refresh, disabled (model.busy || model.client == Nothing) ] [ text "Refresh token" ]
        , h2 [] [ text "Patient search" ]
        , label [] [ text "Given ", input [ value model.given, placeholder "Optional", onInput GivenChanged ] [] ]
        , label [] [ text "Family ", input [ value model.family, placeholder "Optional", onInput FamilyChanged ] [] ]
        , button [ onClick Search, disabled (model.busy || model.client == Nothing) ] [ text "Search" ]
        , p [] [ text "Leave both blank for an initial search. Then try a name from a returned Patient." ]
        , pre [] [ text (if String.isEmpty model.requestUrl then "" else "GET " ++ model.requestUrl) ]
        , case model.bundle of
            Nothing ->
                text ""

            Just bundle ->
                div []
                    [ p []
                        [ text
                            ("Returned " ++ String.fromInt (List.length bundle.entry) ++ " resources on this page. Total: "
                                ++ (Maybe.map String.fromInt bundle.total |> Maybe.withDefault "not supplied")
                            )
                        ]
                    , ul [] (List.map (\entry -> li [] [ pre [] [ text (resourceJson entry.resource) ] ]) bundle.entry)
                    ]
        ]


resourceJson : FHIR.Resource.Resource -> String
resourceJson resource =
    case resource of
        FHIR.Resource.Patient json ->
            Json.Encode.encode 2 json

        FHIR.Resource.Condition json ->
            Json.Encode.encode 2 json

        FHIR.Resource.Other _ json ->
            Json.Encode.encode 2 json


httpError : Http.Error -> String
httpError error =
    case error of
        Http.BadUrl url ->
            "Invalid URL: " ++ url

        Http.Timeout ->
            "Request timed out."

        Http.NetworkError ->
            "Network error. Check the browser Network panel for connectivity or CORS errors."

        Http.BadStatus status ->
            "HTTP " ++ String.fromInt status ++ ". For 401, refresh the token and retry the search."

        Http.BadBody details ->
            "FHIR response decoding failed: " ++ details
