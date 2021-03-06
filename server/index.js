// const request = require('request');
const request = require('request-promise');
const mqtt = require('mqtt');
const express = require('express');
const Nexmo = require('nexmo');
const cron = require("node-cron");
const StringBuilder = require("string-builder");
const app = express();
const router = express.Router();
const API_PORT = 8080;
const sensor_f3 = "lairdc0ee4000010109f3"; //The sensor with id 'lairdc0ee4000010109f3'
const sensor_45 = "lairdc0ee400001012345"; //The sensor with id 'lairdc0ee400001012345'
const distance_sensor_from_river_bed_sensor_f3 = 1820;
const distance_flood_plain_from_river_bed_sensor_f3 = 1820;
const distance_sensor_from_river_bed_sensor_45 = 1340;
const distance_flood_plain_from_river_bed_sensor_45 = 1200;

const SUBSCRIBE_EMAIL_TEXT = "Hello!<br /><br />Thanks for subscribing to the email flood alerts and warnings!" +
" Daily emails at 9am will be sent, containig updates about flood alerts and warning for a 5km radius!<br /><br /><br /> Stay dry,<br />floodalertskentuk"
const SUBSCRIBE_SMS_TEXT = "Hello!\n\nThanks for subscribing to the SMS flood alerts and warnings!\n\n" +
"You will receive daily SMS update at 9am about flood alerts and warning for a 5km radius!\n\nStay dry!"

var bodyParser = require('body-parser');
var nodemailer = require('nodemailer');
var queryHandler = require('./queryHandler');
var weatherForecast = require('./weatherForecast');
var geoLib = require('geo-lib'); //A library which helps with coordinates calculations

var options = require('./options'); //The parsed options file
var host = options.storageConfig.mqtt_host;
var port = options.storageConfig.port;
var appID = options.storageConfig.appID;
var accessKey = options.storageConfig.accessKey;
var nodemailer_service = options.storageConfig.nodemailer_service;
var nodemailer_user = options.storageConfig.nodemailer_user;
var nodemailer_pwd = options.storageConfig.nodemailer_pwd;
var nexmo_apiKey = options.storageConfig.nexmo_apiKey;
var nexmo_apiSecret = options.storageConfig.nexmo_apiSecret;
router.use(bodyParser.json()); // support json encoded bodies
router.use(bodyParser.urlencoded({
  extended: true
})); // support encoded bodies

var mqtt_options = {
  port: port,
  username: appID,
  password: accessKey
};

const nexmo = new Nexmo({
  apiKey: nexmo_apiKey,
  apiSecret: nexmo_apiSecret
})

var transporter = nodemailer.createTransport({
  service: nodemailer_service,
  auth: {
    user: nodemailer_user,
    pass: nodemailer_pwd
  }
});

const client = mqtt.connect(host, mqtt_options);

var hexPayload; //distance to water (hex)
var distance; //distance to water in mm
var floodAlert = false;

function sendEmail(to, subject, htmlContent) {
  const mailOptions = {
    from: 'floodalertskentuk@gmail.com', // sender address
    to, // list of receivers
    subject, // Subject line
    html: htmlContent // plain text body
  };

  transporter.sendMail(mailOptions, function(err, info) {
    if (err)
      console.log(err)
    else
      console.log(info);
  });
}

function sendSMS(to, text) {
  const from = 'floodalertskentuk'
  //e.g. to = 447424124821
  nexmo.message.sendSms(from, to, text)
}

// receive data and add it to a database
client.on('connect', () => {
  console.log("Connected");
  client.subscribe('kentwatersensors/devices/+/up', () => {
    client.on('message', (topic, message, packet) => {
      var payload = JSON.parse(message);
      console.log("Received message from " + payload.dev_id);
      hexPayload = Buffer.from(payload.payload_raw, 'base64').toString('hex'); //the distance in hex format
      distance = parseInt(hexPayload, 16); //the integer value (distance in mm)

      var distance_sensor_from_river_bed;
      var distance_flood_plain_from_river_bed;

      switch (payload.dev_id) {
        case sensor_45:
          distance_sensor_from_river_bed = distance_sensor_from_river_bed_sensor_45;
          distance_flood_plain_from_river_bed = distance_flood_plain_from_river_bed_sensor_45;
          break;
        case sensor_f3:
          distance_sensor_from_river_bed = distance_sensor_from_river_bed_sensor_f3;
          distance_flood_plain_from_river_bed = distance_flood_plain_from_river_bed_sensor_f3;
          break;
      }

      if (distance <= distance_sensor_from_river_bed - distance_flood_plain_from_river_bed) {
        floodAlert = true;
      }

      var waterLvl = distance_sensor_from_river_bed - distance;
      var params = {
        timestamp: payload.metadata.time,
        devID: payload.dev_id,
        distanceToSensor: distance,
        waterLevel: waterLvl
      };

      queryHandler.insertLocalDataRecord(params);
      floodAlert = false;
    });
  });
});

function getLatestData(stationReference) {
  return request('https://environment.data.gov.uk/flood-monitoring/id/stations/' + stationReference + '/readings?_sorted&_limit=1', {
      json: true
    })
    .then(function(data) {
      return {
        ref: stationReference,
        datetime: data.items[0].dateTime,
        val: data.items[0].value
      };
    }).catch((err) => setImmediate(() => {
      throw err;
    }));
}

/**
 * Returns the closest n (noOfResults) stations of a given type (sensorType
 * ("level" for water level stations
 *  "rainfall" for rainfall stations))
 * within a given radius (in km) of a given point on a map's coordinates (latitude,longitude)
 * NB: the 'request' package supports HTTPS and follows redirects by default :-)
 *
 * @param  {long} latitude      Geographical latitude
 * @param  {long} longitude     Geographical longitude
 * @param  {int} radius         The radius to look for sensors in
 * @param  {String} sensorType  The type of the sensor - level /rainfall)
 * @param  {int} noOfResults    The requested number of closest stations
 * @return {array}              The closest n stations
 */
function getNearestGovStations(latitude, longitude, radius, sensorType, noOfResults) {
  return request('https://environment.data.gov.uk/flood-monitoring/id/stations/?lat=' + latitude + '&long=' + longitude + '&dist=' + radius, {
      json: true
    })
    .then(function(data) {
      var sensors = data.items;
      var locationsMap = {};
      for (var i = 0; i < sensors.length; i++) {
        if (sensors[i].measures[0].parameter == sensorType) {
          locationsMap[sensors[i].notation] = locationsMap[sensors[i].notation] || [];
          locationsMap[sensors[i].notation].push(sensors[i].lat, sensors[i].long);
        }
      }

      var distancesMap = {};
      Object.keys(locationsMap).forEach(function(key) {
        var result = geoLib.distance([
          [latitude, longitude],
          [locationsMap[key][0], locationsMap[key][1]]
        ]);
        distancesMap[key] = distancesMap[key] || [];
        distancesMap[key].push(result.distance);
      });
      var sortedDistances = [];
      for (var distance in distancesMap) {
        sortedDistances.push([distance, distancesMap[distance]]);
      }
      sortedDistances.sort(function(a, b) {
        return a[1] - b[1];
      });
      var stations = [];
      for (var i = 0; i < sortedDistances.length; i++) {
        stations.push(sortedDistances[i][0]);
      }

      return stations.slice(0, noOfResults);

    })
    .catch((err) => setImmediate(() => {
      throw err;
    }));
}

function addEnvAgencyData() {
  getNearestGovStations('51.280233', '1.0789089', 5, 'level', 5)
    .then(result => {
      nearestStations = result;
      var promises = [];
      result.map(stationReference => {
        promises.push(getLatestData(stationReference));
      });
      Promise.all(promises).then(data => {
        for (var i = 0; i < data.length; i++) {
          var params = {
            timestamp: data[i].datetime,
            stationReference: data[i].ref,
            readingValue: data[i].val * 1000
          };
          queryHandler.insertEnvAgencyDataRecord(params);
        }
      })
    }).catch((err) => setImmediate(() => {
      throw err;
    }));
}

addEnvAgencyData();

//check for new EA data for each of the nearest sensors every 15 minutes
cron.schedule('*/15 * * * *', function() {
  addEnvAgencyData();
});

//running subscribe check every day at 9 am
cron.schedule('0 0 9 * * *', function() {
  queryHandler.getSubscribers().then(result => {
    var i, lat, long, phone, email;
    for(i = 0; i < result.length; i++) {
      lat = result[i].latitude;
      long = result[i].longitude;
      email = result[i].email;
      phone = result[i].contactNumber;
      request('https://environment.data.gov.uk/flood-monitoring/id/floods/?lat=' + lat + '&long=' + long + '&dist=5', {
          json: true
        }).then((data) => {
          var a;
          var items = data.items;
          let txt = new StringBuilder();
          txt.append("Hello!<br /><br />");
          txt.append("This is your daily update about alerts and warning in a 5km radius from your location.<br /><br />");
          if(items.length > 0) {
            for(a = 0; a < items.length; a++) {
              txt.append("Description: ")
              txt.append(items[a].description);
              txt.append("<br /><br />")
              txt.append("Message: ")
              txt.append(items[a].message);
              txt.append("<br /><br />")
              txt.append("Severity: ")
              txt.append(items[a].severity);
              txt.append("<br /><br />")
              txt.append("Severity Level: ")
              txt.append(items[a].severityLevel);
              txt.append("<br /><br /><br />")
            }
          } else {
            txt.append("No alerts or warning around you!<br /><br />");
          }
          txt.append("Stay dry,<br />floodalertskentuk");
          if(email !== null) {
            sendEmail(email, "Flood Alerts And Warning", txt.toString());
          }
          if(phone !== null) {
            sendSMS(phone, txt.toString());
          }
        }).catch((err) => setImmediate(() => {
          throw err;
        }));
    }
  }).catch((err) => setImmediate(() => {
    throw err;
  }));
});

function testRequest(email, lat, long) {
  request('https://environment.data.gov.uk/flood-monitoring/id/floods/?lat=' + lat + '&long=' + long + '&dist=5', {
      json: true
    }).then((data) => {
      var a;
      var items = data.items;
      let txt = new StringBuilder();
      txt.append("Hello!<br /><br />");
      txt.append("This is a TEST email about warnings and alerts in the area of 5 km from the given coordinates.<br /><br />");
      if(items.length > 0) {
        for(a = 0; a < items.length; a++) {
          txt.append("Description: ")
          txt.append(items[a].description);
          txt.append("<br /><br />")
          txt.append("Message: ")
          txt.append(items[a].message);
          txt.append("<br /><br />")
          txt.append("Severity: ")
          txt.append(items[a].severity);
          txt.append("<br /><br />")
          txt.append("Severity Level: ")
          txt.append(items[a].severityLevel);
          txt.append("<br /><br /><br />")
        }
      } else {
        txt.append("TEST: No alerts or warning around you!<br /><br />");
      }
      txt.append("Stay dry,<br />floodalertskentuk");
      if(email !== null) {
        sendEmail(email, "Flood Alerts And Warning", txt.toString());
      }
    }).catch((err) => setImmediate(() => {
      throw err;
    }));
}

//example use of getLatestEnvAgencyReading
queryHandler.getLatestEnvAgencyReading('E3966').then(result => {
  // console.log(result);
}).catch((err) => setImmediate(() => {
  throw err;
}));

//exampleuse of getEnvAgencyDataForPeriod
queryHandler.getEnvAgencyDataForPeriod('E3826','2018-12-11','2018-12-13').then(result => {
  console.log(result);
}).catch((err) => setImmediate(() => {
  throw err;
}));


function getPolygonData(urls) {
  let polygonCoordinates = [];
  // map all urls to async requests
  var promises = urls.map(url => request(url, {
    json: true
  }));
  // return an array of promises
  return Promise.all(promises)
    .then((data) => {
      return data;
    });
}

// this is our get method
// this method fetches all available data in our database
router.get("/getData/:deviceId/:startDate?/:endDate?", (req, res) => {
  // if start and end date have not been passed as parameters
  // then we need to return the latest reading
  let funCall = ((!req.params.startDate || !req.params.endDate) ?
    queryHandler.getLatestLocalReading(req.params.deviceId) :
    queryHandler.getLocalDataForPeriod(req.params.deviceId, req.params.startDate, req.params.endDate));
  funCall.then(function(rows) {
      res.json(rows);
    })
    .catch((err) => setImmediate(() => {
      throw err;
    }));
});

// this is our get method
// this method fetches all available data in our database
router.get("/getEAData/:deviceId/:startDate?/:endDate?", (req, res) => {
  let funCall = ((!req.params.startDate || !req.params.endDate) ?
    queryHandler.getLatestEnvAgencyReading(req.params.deviceId) :
    queryHandler.getEnvAgencyDataForPeriod(req.params.deviceId, req.params.startDate, req.params.endDate));
  funCall.then(function(rows) {
      res.json(rows);
    })
    .catch((err) => setImmediate(() => {
      throw err;
    }));
});

router.post("/subscribe", (req, res, next) => {
  if(req.body.hasOwnProperty("email")) {
    sendEmail(req.body.email, "Subscription", SUBSCRIBE_EMAIL_TEXT);
  }
  if(req.body.hasOwnProperty("phone")) {
    sendSMS(req.body.phone, SUBSCRIBE_SMS_TEXT);
  }

  var params = {
    latitude: req.body.location.lat,
    longitude: req.body.location.long,
    county: 'Kent',
    name: req.body.name,
    email: req.body.email,
    contactNumber: req.body.phone
  };

  queryHandler.addSubscriber(params);

  // sendSMS(447424124***, "text"); works only with pre-verified numbers, since it is a trial
  // sendEmail("d**@kent.ac.uk", "subject", "htmlContent");
});

router.post("/test", (req, res, next) => {
  if(req.body.hasOwnProperty("email") && req.body.hasOwnProperty("lat") && req.body.hasOwnProperty("long")) {
    testRequest(req.body.email, req.body.lat, req.body.long);
  }
});

queryHandler.getSubscribers().then(result => {
  // console.log(result);
  return result;
}).catch((err) => setImmediate(() => {
  throw err;
}));

// this returns all flood areas polygon coordinates from the EA API
router.get("/getFloodAreas", (req, res) => {
  var areasURLs = []; // array to put all polygon coordinates in
  var items = []; // array to keep the item objects in as we need to return them too

  // call appropriate url depending on whether query parameter has been passed
  let url = (req.query.current ?
    'https://environment.data.gov.uk/flood-monitoring/id/floods' :
    'https://environment.data.gov.uk/flood-monitoring/id/floodAreas?lat=51.2802&long=1.0789&dist=5');

  request(url, {
      json: true
    })
    .then(function(body) {
      items = body.items;
      // extract polygon objects from response
      body.items.forEach(area => {
        if (req.query.current) {
          areasURLs.push(area.floodArea.polygon);
        } else {
          areasURLs.push(area.polygon);
        }
      })
      // this returns a promise for the next then callback
      return getPolygonData(areasURLs);
    })
    .then(data => {
      // return an array of multipolygon coordinates
      res.json([items, data]);
    })
    .catch((err) => setImmediate(() => {
      throw err;
    }));
});

router.get("/weather", (req, res) => {
  weatherForecast.getCurrentRainData(51.2802, 1.0789).then(function(data) {
      res.json(data);
    })
    .catch((err) => setImmediate(() => {
      throw err;
    }));
});

// append /api for our http requests
app.use("/api", router);

// launch our backend into a port
app.listen(API_PORT, () => console.log(`LISTENING ON PORT ${API_PORT}`));
