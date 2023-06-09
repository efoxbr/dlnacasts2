"use strict";

const SSDP = require('./ssdp');
const EventEmitter = require('events').EventEmitter;
const http = require('http');
const getPort = require('./get-port');

function getXML(address) {
    return new Promise((resolve, reject) => {
        http.get(address, (res) => {
            let body = '';
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                resolve(body.toString());
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

function getXmlArg(name, xml) {
	var matched = xml.match(new RegExp('<'+name+'>(.+?)<\/'+name+'>', ''));
    return matched && matched[1] ? matched[1] : '';
}

class Finder extends EventEmitter {
    constructor() {
        super();
        this._upnpSSDP = null;
        this._devices = [];
    }
    search(ssdp) {
        return new Promise((resolve) => {
            ssdp.onResponse((headers, rinfo) => {
                if (!headers.LOCATION || headers.LOCATION.indexOf('https://') !== -1) return;
                getXML(headers.LOCATION).then((xml) => {
                    resolve({ headers, rinfo, xml });
                });
            });
        });
    }
    async start() {
        const port = await getPort();
        this._upnpSSDP = new SSDP(port);      
        const result = await this.search(this._upnpSSDP);
        const { headers, rinfo, xml } = result;

        const name = getXmlArg('friendlyName', xml);
        if (!name) return;

        const device = new EventEmitter();
        device.name = name;
        device.modelName = getXmlArg('modelName', xml);
        device.modelDescription = getXmlArg('modelDescription', xml);
        device.modelNumber = getXmlArg('modelNumber', xml);
        device.serialNumber = getXmlArg('serialNumber', xml);
        device.address = rinfo.address;
        device.xml = headers.LOCATION;
        device.headers = headers;
        device.type = 'upnp';

        this._devices.push(device);

        this.emit('device', device);
        this._upnpSSDP.search('urn:schemas-upnp-org:device:MediaRenderer:1');
    }

    destroy() {
        this._upnpSSDP.destroy();
    }

    getList() {
        return this._devices;
    }
}

module.exports = Finder;