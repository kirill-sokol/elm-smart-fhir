module FHIR.Resource exposing (Resource(..), decoder)

import Json.Decode as Decode


type Resource
    = Patient Decode.Value
    | Condition Decode.Value
    | Other String Decode.Value


decoder : Decode.Decoder Resource
decoder =
    Decode.field "resourceType" Decode.string
        |> Decode.andThen
            (\resourceType ->
                Decode.map
                    (case resourceType of
                        "Patient" ->
                            Patient

                        "Condition" ->
                            Condition

                        _ ->
                            Other resourceType
                    )
                    Decode.value
            )
