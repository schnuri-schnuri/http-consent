const vocabulary = require("./vocabulary.js");
const onHeaders = require("on-headers");
const vary = require("vary");

/**
 * Middleware function that adds object for consent management
 * @param req
 * @param res
 * @param next
 */
exports.readPrivacyHeader = function (req, res, next) {

    const headerValue = req.header(vocabulary.consentHeader);
    if(! headerValue){
        req.consent = {preferenceSent: false};
    } else{
        req.consent = disassembleHeaderString(headerValue);
    }

    res.locals.ask = []; //later, we can add consent requests here
    res.locals.dataCollectionLog = []; //for logging of data collection
    onHeaders(res, setConsentResponseHeader);

    next();
};


/**
 * Returns if consent for all pairs is given.
 * @param {Object} req - request object
 * @param {...String[]} consentPairs - multiple pairs of [category, reason]
 * @return {boolean}
 */
exports.consentGiven = function(req, ...consentPairs){
    if(typeof req.consent !== "object"){
        console.log("no consent object in request");
        return false;
    }

    if(typeof req.consent.preferenceSent !== "boolean"){
        console.log("malformed consent object");
        return false;
    }

    if(req.consent.preferenceSent === false){
        console.log("no preference sent");
        return false;
    }

    return consentPairs.every(function(currentPair){
        try {
            if(currentPair[0] === "tracking"){
                return req.consent.tracking.includes(currentPair[1]);
            }

            return req.consent[currentPair[0]][currentPair[1]];

        } catch (e) {
            if(currentPair[0] === "tracking"){
                throw e;
            }

            if(vocabulary.categories.includes(currentPair[0])){
                throw "Unknown category '" + currentPair[0] + "'. Is the correct vocabulary file installed?";
            }
            if(vocabulary.purposes.includes(currentPair[1])){
                throw "Unknown purpose '" + currentPair[0] + "'. Is the correct vocabulary file installed?";
            }
            if(typeof req.consent[currentPair[0]] !== "object"){
                throw "consent object malformed";
            }
            if(typeof req.consent[currentPair[0]][currentPair[1]] !== "boolean"){
                throw "category object malformed";
            }

            throw e;
        }
    });
};

/**
 * Returns if preference was sent with user request.
 * @param req
 * @return {boolean}
 */
exports.preferenceSent = function(req){
    if(typeof req.consent !== "object"){
        console.log("no consent object in request");
        return false;
    }

    if(typeof req.consent.preferenceSent !== "boolean"){
        console.log("malformed consent object");
        return false;
    }

    return req.consent.preferenceSent;
};

/**
 * Adds consent request to response header
 * @param {Object} res //todo it is not only an object, is it?
 * @param {String} reason
 * @param {String} id
 * @param {...String[]} requestedConsent
 */
exports.askForConsent = function(res, reason, id, ...requestedConsent){
    if(reason.length > 280){
        console.error("Reasoning text is too long");
    }

    const ask = new AskObject();

    requestedConsent.forEach(function(currentPair){
        try {
            if (currentPair.length !== 2) {
                throw "wrong number of elements in one request pair";
            }
            if (currentPair[0] === "tracking") {
                ask.setting.tracking.push(currentPair[2]);
                return;
            }

            ask.setting[currentPair[0]][currentPair[1]] = true;

        }catch (e) {
            if(currentPair[0] === "tracking"){
                throw e;
            }

            if(!vocabulary.categories.includes(currentPair[0])){
                throw "Unknown category in askForConsent() '" + currentPair[0] + "'. Is the correct vocabulary file installed?";
            }
            if(!vocabulary.purposes.includes(currentPair[1])){
                throw "Unknown purpose in askForConsent() '" + currentPair[0] + "'. Is the correct vocabulary file installed?";
            }
            if(typeof ask.consent[currentPair[0]] !== "object"){
                throw "consent object malformed";
            }
            if(typeof ask.consent[currentPair[0]][currentPair[1]] !== "boolean"){
                throw "category object malformed";
            }

            throw e;
        }
    });


    ask.reason = reason;
    ask.id = id;
    res.locals.ask.push(ask);
};


function setConsentResponseHeader(){
    if(!this.locals.ask){
        console.error("Ask is not set.");
        return;
    }
    if(this.locals.ask.length === 0){
        this.set(vocabulary.ackHeader, 'ACK');
        return;
    }

    let responseString = "ACK {ASK ";

    this.locals.ask.forEach(function(askObject){
        responseString += generateAskValue(askObject);
    });

    responseString += "}";
    console.log(responseString);

    this.set(vocabulary.ackHeader, responseString);
    vary(this, vocabulary.consentHeader);
}

/**
 * generates the ask-value(s) as specified in the protocol.
 * The if both Global-Tracking and other setitngs are asked for in the object, two ask-values are generated.
 * Therefore it is advisable to have two askObjects for tracking and other purposes because than it is possible to have two reason texts.
 * @param {AskObject} askObject
 * @returns {String}
 */
function generateAskValue(askObject){
    if(!askObject){
        console.error("askobject undefined in generateAskValue()");
    }

    let askValue = "";

    askValue += "{";
    if(askObject.setting.containsTrue()){
        askValue += generateSettingString(askObject);
    }

    if(askObject.setting.tracking.length > 0){
        console.log("Tracking: " + askObject.setting.tracking);

        askValue += "{global-tracking ";
        askValue += askObject.setting.tracking.join(",");
        askValue += "}";
    }
    askValue += "}";

    askValue += " ";

    askValue += "ID{";
    askValue += askObject.id;
    askValue += "} TXT{";
    askValue += askObject.reason;
    askValue += "}";

    return askValue;
}

/**
 * Generates Setting String (see setting in protocol from askObject
 * @param {AskObject} askObject
 * @returns {String}
 */
function generateSettingString(askObject) {
    const categoryObject = {};
    //console.log(askObject.setting.keys);
    Object.keys(askObject.setting).forEach(function(category){
        Object.keys(askObject.setting[category]).forEach(function(purpose){
            if(askObject.setting[category][purpose] === true){
                if(! categoryObject.hasOwnProperty(purpose)){
                    categoryObject[purpose] = [];
                }

                categoryObject[purpose].push(category);
            }
        });
    });

    const categoryGroupObject = sortByCategoryGroup(categoryObject);
    return generatePrivacyHeaderPart(categoryGroupObject);
}



/**
 * Takes the preference string and creates consentObject
 * @param {String} str
 * @returns {ConsentObject}
 */
function disassembleHeaderString(str) {
    if (str === "{NOT}"){
        return new ConsentObject();
    }

    const regexIncludingCurlyBraces = /{([^}]+)}/gi;

    const consentObject = new ConsentObject();

    const stringParts = str.match(regexIncludingCurlyBraces);
    stringParts.forEach(function(stringPart) {
        if(stringPart.includes("global-tracking")) {
            disassembleTrackingString(stringPart, consentObject);
        }
        else{
            disassembleSettingString(stringPart, consentObject);
        }

    });

    return consentObject;
}


/**
 * dissasembles the setting string and modifies the object passed
 * @param {String} string
 * @param {ConsentObject} object
 */
function disassembleSettingString(string, object){
    const elementStr = string.substring(1, string.length - 1);
    const elementArr = elementStr.split(" ");

    const categories = [];
    const purposes = [];


    elementArr.forEach(function (element) {
        if(vocabulary.categories.includes(element)){
            categories.push(element);
            return;
        }
        if(vocabulary.purposes.includes(element)){
            purposes.push(element);
            return;
        }

        console.error("unknown element: " + element);
    });

    categories.forEach(function(category){
        purposes.forEach(function(purpose){
            object[category][purpose] = true;
        });
    });
}

/**
 * Disassembles the {global-tracking ...} part of the header value
 * @param {String} string
 * @param {ConsentObject} object
 */
function disassembleTrackingString(string, object){
    const elementStr = string.substring(string.indexOf("global-tracking") + "global-tracking".length, string.length-1);
    object.tracking = elementStr.split(",");
}

/**
 *
 * @constructor
 * @property {ConsentObject} setting
 * @property {String} reason
 * @property {String} id
 */
function AskObject(){
    this.setting = new ConsentObject();
    this.reason = "";
    this.id = ""; //can be kept empty, but then we need a default value todo
}

/**
 *
 * @constructor
 * @property {PurposeConsentObject} coo
 * @property {PurposeConsentObject} equ
 * @property {PurposeConsentObject} sfw
 * @property {PurposeConsentObject} geo
 * @property {String[]} tracking
 * @property {Function} containsTrue()
 *
 */
function ConsentObject() {
    vocabulary.categories.forEach(function (curr) {
        this[curr] = new PurposeConsentObject();
    }, this);

    this.tracking = [];
    this.preferenceSent = true;


    /**
     * Checks if one purpose in one category is true
     * @returns {Boolean}
     */
    this.containsTrue = function(){
        return Object.keys(this).some(function(curr) {
            if(curr === "tracking"){
                return false;
            }
            if(!this[curr]){
                console.error("this[curr] undefined in ConsentObject.containsTrue()");
            }

            return this[curr].containsTrue();
        }, this);
    };
}

/**
 *
 * @constructor
 * @property {Boolean} fcn
 * @property {Boolean} per
 * @property {Boolean} adm
 * @property {Boolean} ana
 * @property {Boolean} com
 * @property {Boolean} trd
 * @property {Boolean} loc
 * @property {Function} containsTrue()
 */
function PurposeConsentObject(){
    vocabulary.purposes.forEach(function (curr){
        this[curr] = false;
    }, this);

    /**
     * Checks if one purpose is true
     * @returns {Boolean}
     */
    this.containsTrue = function () {
        return Object.values(this).includes(true);
    };
}


//from web extension
/**
 * Collects the purposes that have the same categories
 * @param {Object} obj - object with purposes as keys and category groups as value
 * @returns obj - something like {"coo equ": ["adm", "ana"], ...}
 */
function sortByCategoryGroup(obj){
    const categoryGroupObject = {};

    //first collect all purposes with same category group
    for(const fieldName in obj) {
        if(! obj.hasOwnProperty(fieldName)){
            continue;
        }

        const key = obj[fieldName];
        const sortedKey = key.sort();
        const categoryGroup = sortedKey.join(" ");

        if(! categoryGroupObject.hasOwnProperty(categoryGroup)){
            categoryGroupObject[categoryGroup] = [];
        }

        categoryGroupObject[categoryGroup].push(fieldName);
    }

    return categoryGroupObject;
}


//from web extension
/**
 * Generates category-purpose part of header from categoryGroupObject
 * @param {Object} obj
 * @returns{String}
 */

function generatePrivacyHeaderPart(obj){
    const headerValueArray = [];

    //then merge it to categoryPurposeGroup
    for(const categoryGroup in obj){
        if(! obj.hasOwnProperty(categoryGroup)){
            continue;
        }

        const value = obj[categoryGroup];
        const sortedValue =  value.sort();
        const purposeGroup = sortedValue.join(" ");

        const categoryPurposeGroup = "{" + categoryGroup + " " + purposeGroup + "}";
        headerValueArray.push(categoryPurposeGroup);
    }

    headerValueArray.sort(function(a,b){
        return a.length - b.length || a.localeCompare(b); // taken from https://stackoverflow.com/a/10630852
    });

    return headerValueArray.join("");
}
