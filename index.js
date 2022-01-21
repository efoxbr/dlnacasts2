var MediaRenderer = require('upnp-mediarenderer-client')
var debug = require('debug')('dlnacasts')
var events = require('events')
var get = require('simple-get')
var mime = require('mime')
var parallel = require('run-parallel')
var parseString = require('xml2js').parseString

const URN = 'urn:schemas-upnp-org:device:MediaRenderer:1'

var SSDP
try {
  SSDP = require('node-ssdp').Client
} catch (err) {
  SSDP = null
}

var thunky = require('thunky')

var noop = function () {}

module.exports = function (ip, headersCache) {
  var that = new events.EventEmitter()
  var casts = {}
  var args = ip ? {
    location: 'http://'+ ip +':10293/upnp/desc.html',
    //customLogger: console.warn,
    sourcePort: 1900
  } : undefined
  console.log('dlnacasts2', ip, args, SSDP)
  var ssdp = SSDP ? new SSDP(args) : null

  that.players = []

  var emit = function (cst) {
    console.log('dlnacasts.emit', cst)
    if (!cst || !cst.host || cst.emitted) return
    cst.emitted = true

    var player = new events.EventEmitter()

    var connect = thunky(function reconnect (cb) {
      var client = new MediaRenderer(player.xml)

      client.on('error', function (err) {
        player.emit('error', err)
      })

      client.on('status', function (status) {
        console.log('dlnacasts2 status', status, client)
        if (status.TransportState === 'PLAYING') player._status.playerState = 'PLAYING'
        if (status.TransportState === 'PAUSED_PLAYBACK') player._status.playerState = 'PAUSED'
        player.emit('status', player._status)
      })

      client.on('loading', function (err) {
        player.emit('loading', err)
      })

      client.on('close', function () {
        connect = thunky(reconnect)
      })

      player.client = client
      cb(null, player.client)
    })

    var parseTime = function (time) {
      if (!time || time.indexOf(':') === -1) return 0
      var parts = time.split(':').map(Number)
      return parts[0] * 3600 + parts[1] * 60 + parts[2]
    }

    player.name = cst.name
    player.host = cst.host
    player.xml = cst.xml
    player.headers = cst.headers
    player._status = {}
    player.MAX_VOLUME = 100

    player.play = function (url, opts, cb) {
      if (typeof opts === 'function') return player.play(url, null, opts)
      if (!opts) opts = {}
      if (!url) return player.resume(cb)
      if (!cb) cb = noop
      player.subtitles = opts.subtitles
      connect(function (err, p) {
        if (err) return cb(err)

        var media = {
          autoplay: opts.autoPlay !== false,
          contentType: opts.type || mime.lookup(url, 'video/mp4'),
          metadata: opts.metadata || {
            title: opts.title || '',
            type: 'video', // can be 'video', 'audio' or 'image'
            subtitlesUrl: player.subtitles && player.subtitles.length ? player.subtitles[0] : null
          }
        }
        if (opts.dlnaFeatures) {
          media.dlnaFeatures = opts.dlnaFeatures;
        }

        var callback = cb
        if (opts.seek) {
          callback = function () {
            player.seek(opts.seek, cb)
          }
        }

        p.load(url, media, callback)
      })
    }

    player.resume = function (cb) {
      if (!cb) cb = noop
      player.client.play(cb)
    }

    player.pause = function (cb) {
      if (!cb) cb = noop
      player.client.pause(cb)
    }

    player.stop = function (cb) {
      if (!cb) cb = noop
      player.client.stop(cb)
    }

    player.status = function (cb) {
      if (!cb) cb = noop
      parallel({
        currentTime: function (acb) {
          var params = {
            InstanceID: player.client.instanceId
          }
          player.client.callAction('AVTransport', 'GetPositionInfo', params, function (err, res) {
            console.log('GetPositionInfo', err, res)
            if (err) return
            var position = parseTime(res.AbsTime) | parseTime(res.RelTime)
            acb(null, position)
          })
        },
        volume: function (acb) {
          player._volume(acb)
        }
      },
      function (err, results) {
        debug('%o', results)
        player._status.currentTime = results.currentTime
        player._status.volume = {level: results.volume / (player.MAX_VOLUME)}
        return cb(err, player._status)
      })
    }

    player._volume = function (cb) {
      var params = {
        InstanceID: player.client.instanceId,
        Channel: 'Master'
      }
      player.client.callAction('RenderingControl', 'GetVolume', params, function (err, res) {
        if (err) return
        var volume = res.CurrentVolume ? parseInt(res.CurrentVolume) : 0
        cb(null, volume)
      })
    }

    player.volume = function (vol, cb) {
      if (!cb) cb = noop
      var params = {
        InstanceID: player.client.instanceId,
        Channel: 'Master',
        DesiredVolume: (player.MAX_VOLUME * vol) | 0
      }
      player.client.callAction('RenderingControl', 'SetVolume', params, cb)
    }

    player.request = function (target, action, data, cb) {
      if (!cb) cb = noop
      player.client.callAction(target, action, data, cb)
    }

    player.seek = function (time, cb) {
      if (!cb) cb = noop
      player.client.seek(time, cb)
    }

    player._detectVolume = function (cb) {
      if (!cb) cb = noop
      player._volume(function (err, currentVolume) {
        if (err) cb(err)
        player.volume(player.MAX_VOLUME, function (err) {
          if (err) cb(err)
          player._volume(function (err, maxVolume) {
            if (err) cb(err)
            player.MAX_VOLUME = maxVolume
            player.volume(currentVolume, function (err) {
              cb(err, maxVolume)
            })
          })
        })
      })
    }

    that.players.push(player)
    that.emit('update', player)
  }

  var getRetrying = {}
  function getRetry(location, cb, tries=3){
    getRetrying[location] = true
    const onErr = (err, res, body) => {
      console.error('onErr str', String(err), res, body)
      if(!res || res.statusCode != 404){
        if(tries){
          tries--
          setTimeout(() => getRetry(location, cb, tries), 1000)
          return
        }
      }
      delete getRetrying[location]
      return cb(err || 'Failed to connect')
    }
    get.concat(location, (err, res, body) => {
      if (err){
        return onErr(err, res, body)
      }
      parseString(body.toString(), {explicitArray: false, explicitRoot: false},
        (err, service) => {
          if (err){
            return onErr(err, res, body)
          }
          if(!service || !service.device){
            console.log('Service not found', err, res, body)
            return cb('Service not found')
          }
          cb(null, service)
        })
      })

  }

  if (ssdp) {
    const addedLocations = []
    const maybePredictMediaRenderer = (headers, info) => {
      if(headers.NT != URN){
        if(String(headers.LOCATION +' '+headers.USN).indexOf('MediaRenderer') != -1){
          headers.NT = 'urn:schemas-upnp-org:device:MediaRenderer:1'
          if(String(headers.USN).indexOf('MediaRenderer') == -1){
            headers.USN = headers.USN.split('::')[0] +'::'+ URN
          }
          if(String(headers.LOCATION).indexOf('MediaRenderer') == -1){
            headers.LOCATION = headers.LOCATION.split('/').slice(0, 3).join('/') +'/deviceDescription/MediaRenderer'
          }
        }
      }
      return headers
    }
    const getResponse = (headers, statusCode, info) => {
      console.log('getResponse', headers)
      if(!headers) return
      // discovery seems too slow and life is too short, try to discover from other results too
      headers = maybePredictMediaRenderer(headers)
      if (!headers.LOCATION || headers.NT != URN) return
      if(getRetrying[headers.LOCATION] || addedLocations.includes(headers.LOCATION)){
        console.log('Skipping '+ headers.LOCATION, getRetrying[headers.LOCATION], addedLocations)
        return
      }
      console.log('getResponse', headers)
      getRetry(headers.LOCATION, (err, service) => {
        console.log('getResponse', headers, err, service)
        if (err) return
        addedLocations.push(headers.LOCATION)
        debug('device %j', service.device)
        var name = service.device.friendlyName
        if (!name) return
        if(!headers.address) headers.address = info.address // to allow cache headers only

        var host = headers.address
        var xml = headers.LOCATION

        console.log('getResponse', headers, err, service)
        if (!casts[name]) {
          casts[name] = {name, host, xml, headers}
          return emit(casts[name])
        } else {
          const net = require('net')
          if(!casts[name].host || !net.isIP(casts[name].host) || net.isIP(casts[name].host) == 4){ // prefer ipv4
            casts[name].host = host
            casts[name].xml = xml
            casts[name].headers = headers
            casts[name].emitted = false // re-emit with the new host
            return emit(casts[name])
          }
        }
      })
    }
    ssdp.on('advertise-alive', function (headers, rinfo) {
      getResponse(headers, 200, rinfo)
    })
    ssdp.on('response', getResponse)
    if(headersCache){
      // allow to use a cache from previous discoveries
      Object.values(headersCache).forEach(getResponse)
    }
  }

  that.update = function (timeout=5000) {
    debug('querying ssdp')
    if (ssdp) {
		ssdp.search(URN);
		setTimeout(function() {},timeout);
	}
  }

  that.destroy = function () {
  }

  that.update()

  return that
}
