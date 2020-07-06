'use strict';

// OpenStreetMap India
// https://wiki.openstreetmap.org/wiki/Map_internationalization_(India)
// Tileset 
// 'https://b.tiles.mapbox.com/v4/planemad.6mk61jbn/{z}/{x}/{y}.vector.pbf?access_token=pk.eyJ1Ijoib3NtLWluIiwiYSI6ImNqcnVxMTNrNTJwbHc0M250anUyOW81MjgifQ.cZnvZEyWT5AzNeO3ajg5tg'


//
// Add localised labels from Wikidata to the GeoJSON data
//
// 1. Export OSM data as export.geojson
// - world-places http://overpass-turbo.eu/s/VPm
// - india-urban-places http://overpass-turbo.eu/s/VPn
// - india-rural-places http://overpass-turbo.eu/s/VPn
// 2. Run `./join-wikidata-labels.js`
// 3. `tippecanoe -zg -o indic-places.mbtiles --drop-densest-as-needed --extend-zooms-if-still-dropping world-places-translated.geojson india-urban-places-translated.geojson india-rural--places-translated.geojson`
//

const fs = require('fs');

const nodeFetch = require('node-fetch');
var fetch = require('fetch-retry')(nodeFetch, {
    retries: 5,
    retryDelay: 500
});

const _ = require('lodash');
const Bottleneck = require("bottleneck/es5");

const limiter = new Bottleneck({
    minTime: 50,
    maxConcurrent: 5
});

// const WDK = require('wikibase-sdk');

// let wdk = WDK({
//     instance: 'https://www.wikidata.org',
//     sparqlEndpoint: 'https://query.wikidata.org/sparql'
// })

// let geojson = fs.readFileSync('places.geojson');

const inputFileName = 'india-rural-places.geojson'
const outputFileName = inputFileName.split('.')[0] + '-translated.geojson'

const features = JSON.parse(fs.readFileSync(inputFileName)).features;


const languages = ["as", "bn", "brx", "doi", "en", "gu", "hi", "kn", "ks", "gom", "mai", "ml", "mni", "mr", "ne", "or", "pa", "sa", "sat", "sd", "ta", "te", "ur"];

let filterProps = ["place", "wikidata", "name"]
languages.forEach(item => filterProps.push("name:" + item))

const qidField = 'wikidata'
const preferWikidataLabel = true
const requestChunkSize = 250


let joinWikidataLabels = function (features, languages) {

    // Filter features to only include those with a qid

    features = features.filter(item =>
        item.properties.hasOwnProperty(qidField)
    )

    // Drop all fields except names and wikidata id

    features.map(item => {
        Object.keys(item.properties).forEach(prop => {

            if (!prop.startsWith("name") && ['place', 'wikidata', '@id'].indexOf(prop) == -1) {
                delete item.properties[prop]
            }
        })
        return item
    })

    // Build a list of qids that need to be queried on Wikidata

    let qids = []

    features.forEach(item => {
        if (item.properties.hasOwnProperty(qidField)) {
            qids.push(item.properties[qidField]);
        }
    });

    // Split list of qids into smaller chunks
    // Get localised labels from Wikidata using the qid

    let requests = []

    while (qids.length) {
        let qidsPage = qids.splice(0, requestChunkSize);
        requests.push(translateQids(qidsPage, languages))
    }

    console.log(`Fetching Wikidata translations from ${requests.length} API requests`)

    // Collect all the Wikidata results

    Promise.all(requests).then(data => {

        console.log(`Processing results`)

        data = Object.assign({}, ...data)

        // Join properties from Wikidata
        // Add translation if it exists

        features.map(item => {

            languages.forEach(langCode => {

                // Check if feature has a qid and a translation is available
                // Additionally check if the feature already has an existing translation for that language

                if (
                    item.properties.hasOwnProperty(qidField) &&
                    data[item.properties[qidField]].hasOwnProperty(langCode)
                ) {
                    if (preferWikidataLabel && !item.properties.hasOwnProperty('name:' + langCode))
                        item.properties['name:' + langCode] = data[item.properties[qidField]][langCode];
                } else {
                    // item.properties['name:' + langCode] = null;
                }

            })

            item.properties = _.pick(item.properties, filterProps);

        });

        let geoJSON = {
            "type": "FeatureCollection",
            "features": features
        }

        fs.writeFileSync(outputFileName, JSON.stringify(geoJSON));

    });

}

//
// Get the translated labels for the given Wikidata QIDs in the requested languages
//



let translateQids = function (qids, languages) {

    // Build a query for the Wikidata SPARQL endpoint

    let sparqlQuery = `
        # Test query at https://w.wiki/QQX
        SELECT ?item (REPLACE(STR(?item),STR(wd:),"") as ?qid)  
        ${languages.map(lang => '?itemLabel_' + lang).join(" ")} 
        {
            VALUES ?item { ${qids.map(el => 'wd:' + el).join(" ")} } # Qid list
            ${languages
                .map(
                    lang =>
                    `OPTIONAL { ?item rdfs:label ?itemLabel_${lang}. FILTER(LANG(?itemLabel_${lang})="${lang}")}`
                    )
                    .join(" ")}    
                }
                `;

    // Formats the result into a dictionary for easy use     

    let result = queryWikidata(sparqlQuery)
        .then(result =>
            result.map(item => ({
                [item.qid]: (function () {
                    var obj = {};
                    languages.forEach(lang => {

                        // Add the label for each language. 
                        // Run the label through the cleaning filter before using
                        if (item["itemLabel_" + lang]) {

                            let label = item["itemLabel_" + lang]
                            obj[lang] = cleanLabel(label)

                        }
                    });
                    return obj;
                })()
            }))
        )
        .then(mapped => Object.assign({}, ...mapped))
        .catch((error) => {
            console.log(error)
        });

    return result;
}

//
// Fetch JSON results from Wikidata using a SPARQL query
//

let queryWikidata = function (sparql) {

    let sparqlEndpoint = 'https://query.wikidata.org/sparql'
    let prettyResult = true

    var resultPromise = limiter.schedule(() =>
            fetch(
                `${sparqlEndpoint}?query=${encodeURIComponent(
                            sparql
                            )}&format=json`, {
                    headers: {
                        accept: "application/sparql-results+json",
                        "user-agent": "join-osm-wikidata-label/0.1 (https://github.com/osm-in/indic-map/issues/1; arun.planemad@gmail.com) node-fetch" // See https://meta.wikimedia.org/wiki/User-Agent_policy
                    }
                }
            ))
        .then(response => response.json())
        .then(json => {

            // Remap result values into a pretty object
            
            let result = json.results.bindings;

            if (prettyResult) {
                result.forEach((row, i) =>
                    Object.keys(row).forEach(k => {
                        result[i][k] = row[k].value;
                    })
                );
            }

            return result;
        })
        .catch(function (error) {
            console.log("Network Error", error);
        });

    return resultPromise;
}



// Wikidata label cleaning filter
function cleanLabel(label) {

    // Remove text after comma. This removes common qualifier text eg. `Bhopal, Madhya Pradesh' -> 'Bhopal'
    label = label.split(',')[0];

    return label;
}


let result = joinWikidataLabels(features,
    languages
)

