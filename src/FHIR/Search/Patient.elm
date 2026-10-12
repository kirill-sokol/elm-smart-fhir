module FHIR.Search.Patient exposing (Params, default)


type alias Params =
    { given : List String
    , family : List String
    }


default : Params
default =
    { given = []
    , family = []
    }
