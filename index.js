const MediaRenderer = require('upnp-mediarenderer-client')
const events = require('events')
const mime = require('mime')
const parallel = require('run-parallel')
const net = require('net')
const http   = require('http')
const RendererFinder = require('renderer-finder');
const thunky = require('thunky')
const noop = function () {}

module.exports = function () {
  const that = new events.EventEmitter()
  const casts = {}
  let finder

  that.players = []

  const emit = function (cst) {
    if (!cst || !cst.host || cst.emitted) return
    cst.emitted = true

    const player = new events.EventEmitter()

    const connect = thunky(function reconnect (cb) {
      const client = new MediaRenderer(player.xml)

      client.on('error', function (err) {
        player.emit('error', err)
      })

      client.on('status', function (status) {
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

    const parseTime = function (time) {
      if (!time || time.indexOf(':') === -1) return 0
      const parts = time.split(':').map(Number)
      return parts[0] * 3600 + parts[1] * 60 + parts[2]
    }

    player.name = cst.name
    player.host = cst.host
    player.xml = cst.xml
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

        const media = {
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
          const params = {
            InstanceID: player.client.instanceId
          }
          player.client.callAction('AVTransport', 'GetPositionInfo', params, function (err, res) {
            if (err) return
            const position = parseTime(res.AbsTime) | parseTime(res.RelTime)
            acb(null, position)
          })
        },
        volume: function (acb) {
          player._volume(acb)
        }
      },
      function (err, results) {
        player._status.currentTime = results.currentTime
        player._status.volume = {level: results.volume / (player.MAX_VOLUME)}
        return cb(err, player._status)
      })
    }

    player._volume = function (cb) {
      const params = {
        InstanceID: player.client.instanceId,
        Channel: 'Master'
      }
      player.client.callAction('RenderingControl', 'GetVolume', params, function (err, res) {
        if (err) return
        const volume = res.CurrentVolume ? parseInt(res.CurrentVolume) : 0
        cb(null, volume)
      })
    }

    player.volume = function (vol, cb) {
      if (!cb) cb = noop
      const params = {
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

  const found = (name, host, xml) => {
    if (!casts[name]) {
      casts[name] = {name, host, xml}
      return emit(casts[name])
    } else {
      if(!casts[name].host || !net.isIP(casts[name].host) || net.isIP(casts[name].host) == 4){ // prefer ipv4
        casts[name].host = host
        casts[name].xml = xml
        casts[name].emitted = false // re-emit with the new host
        return emit(casts[name])
      }
    }
  }
  
  that.update = () => {
    that.search()
  }
  
  that.search = () => {
    if(finder) return
    finder = new RendererFinder()
    finder.on('found', (info, msg, desc) => {
      console.warn('found', info, msg, desc)
      if(!desc) return
      const host = info.address
      const xml = msg.location
      const name = desc && desc.device ? desc.device.friendlyName : info.address
      found(name, host, xml)
    })
    finder.on('error', console.error)
    finder.start(true)
  }
  
  that.stopSearching = () => {
    finder && finder.stop()
    finder = null
  }

  that.validate = (name, host, xml) => {
    if (!casts[name]) {
      http.get(xml, res => {
        const {statusCode} = res
        if (statusCode == 200) {
          if (!casts[name]) {
            found(name, host, xml)
          }
        }
        res.resume()
      }).on('error', e => {})
    }
  }

  that.destroy = function () {
  }

  that.update()

  return that
}
