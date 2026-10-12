module FHIR exposing (Bundle, Client, Entry, Request, Search(..), bundleDecoder, prepare, search, send)

import Dict
import FHIR.Resource
import FHIR.Search.Condition
import FHIR.Search.Patient
import Http
import Json.Decode as Decode
import Url.Builder


type alias Client =
    { baseUri : String
    , accessToken : String
    }


type Search
    = Patient FHIR.Search.Patient.Params
    | Condition FHIR.Search.Condition.Params


type alias Bundle =
    { total : Maybe Int
    , entry : List Entry
    }


type alias Entry =
    { resource : FHIR.Resource.Resource }


bundleDecoder : Decode.Decoder Bundle
bundleDecoder =
    Decode.field "resourceType" Decode.string
        |> Decode.andThen
            (\resourceType ->
                if resourceType == "Bundle" then
                    Decode.map2 Bundle
                        (optionalField "total" (Decode.nullable Decode.int) Nothing)
                        (optionalField "entry" (Decode.list (Decode.map Entry (Decode.field "resource" FHIR.Resource.decoder))) [])

                else
                    Decode.fail "Expected a FHIR Bundle."
            )


optionalField : String -> Decode.Decoder a -> a -> Decode.Decoder a
optionalField name decoder fallback =
    Decode.dict Decode.value
        |> Decode.andThen
            (\fields ->
                case Dict.get name fields of
                    Nothing ->
                        Decode.succeed fallback

                    Just value ->
                        case Decode.decodeValue decoder value of
                            Ok decoded ->
                                Decode.succeed decoded

                            Err error ->
                                Decode.fail (Decode.errorToString error)
            )


type alias Request a =
    { method : String
    , headers : List Http.Header
    , url : String
    , body : Http.Body
    , expect : Http.Expect (Result Http.Error a)
    , timeout : Maybe Float
    , tracker : Maybe String
    }


search : Search -> Request Bundle
search resourceSearch =
    let
        ( resource, query ) =
            case resourceSearch of
                Patient params ->
                    ( "Patient"
                    , List.map (Url.Builder.string "given") params.given
                        ++ List.map (Url.Builder.string "family") params.family
                    )

                Condition _ ->
                    ( "Condition", [] )
    in
    { method = "GET"
    , headers = [ Http.header "Accept" "application/fhir+json" ]
    , url = Url.Builder.relative [ resource ] query
    , body = Http.emptyBody
    , expect = Http.expectJson identity bundleDecoder
    , timeout = Nothing
    , tracker = Nothing
    }


prepare : Client -> Request a -> Request a
prepare client request =
    let
        baseUri =
            if String.endsWith "/" client.baseUri then
                String.dropRight 1 client.baseUri

            else
                client.baseUri
    in
    { request
        | url = baseUri ++ "/" ++ request.url
        , headers = Http.header "Authorization" ("Bearer " ++ client.accessToken) :: request.headers
    }


send : Client -> Request a -> Cmd (Result Http.Error a)
send client request =
    prepare client request
        |> Http.request
