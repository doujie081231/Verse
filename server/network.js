/**
 * @file server/network.js
 * @description UPnP 端口映射与 MC Ping 功能模块。通过 ctx (./context) 访问共享状态，
 *   通过 utils (./utils) 访问工具函数，通过 httpClient (./http-client) 访问 HTTP 客户端功能。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const dgram = require('dgram');
const url = require('url');
const os = require('os');

const ctx = require('./context');
const utils = require('./utils');
const httpClient = require('./http-client');

/* 辅助函数 */

/* UPnP */

/**
 * 查找与网关同网段的本地 IPv4 地址
 * @param {string} gatewayAddress - 网关 IP 地址
 * @returns {string} 本地 IPv4 地址，找不到返回 '127.0.0.1'
 */
function getLocalIPForGateway(gatewayAddress) {
  const netIfs = os.networkInterfaces();
  for (const name of Object.keys(netIfs)) {
    for (const net of netIfs[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        const parts = net.address.split('.').map(Number);
        const gwParts = gatewayAddress.split('.').map(Number);
        if (parts[0] === gwParts[0] && parts[1] === gwParts[1] && parts[2] === gwParts[2]) {
          return net.address;
        }
      }
    }
  }
  /* 同网段未命中，回退首个非内部 IPv4 */
  for (const name of Object.keys(netIfs)) {
    for (const net of netIfs[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * 通过 SSDP 发现 UPnP 网关（结果缓存）
 * @returns {Promise<Object>} { location: string, address: string }
 * @throws {Error} 未检测到 UPnP 网关时抛出
 */
async function discoverUPnPGateway() {
  if (ctx.network.upnpGatewayCache) {
    return ctx.network.upnpGatewayCache;
  }

  const searchTypes = [
    'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
    'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
    'upnp:rootdevice'
  ];

  for (const st of searchTypes) {
    try {
      const result = await _ssdpSearch(st, 3);
      if (result) {
        ctx.network.upnpGatewayCache = result;
        return result;
      }
    } catch (e) {
    }
  }

  throw new Error('未检测到UPnP网关。请检查: 1) 路由器已开启UPnP功能 2) Windows SSDP发现服务未被禁用 3) 防火墙允许UDP 1900端口');
}

/* 通过 SSDP M-SEARCH 搜索 UPnP 设备（带重试） */
function _ssdpSearch(searchType, maxRetries) {
  return new Promise((resolve, reject) => {
    const dgram = require('dgram');
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const ssdpMsg = [
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 5',
      `ST: ${searchType}`,
      '', ''
    ].join('\r\n');

    let found = false;
    let retryCount = 0;
    let retryTimer = null;
    const timeout = 8000;

    const timer = setTimeout(() => {
      if (!found) {
        clearTimeout(retryTimer);
        socket.close();
        reject(new Error(`SSDP search timeout for ${searchType}`));
      }
    }, timeout);

    socket.on('message', (msg, rinfo) => {
      const str = msg.toString();
      if (str.includes('InternetGatewayDevice') || str.includes('WANIPConnection') || str.includes('WANPPPConnection')) {
        const locationMatch = str.match(/LOCATION:\s*(.+)/i);
        if (locationMatch) {
          found = true;
          clearTimeout(timer);
          clearTimeout(retryTimer);
          socket.close();
          const result = { location: locationMatch[1].trim(), address: rinfo.address };
          resolve(result);
        }
      }
    });

    socket.on('error', (e) => {
      clearTimeout(timer);
      clearTimeout(retryTimer);
      socket.close();
      reject(e);
    });

    socket.bind(() => {
      try {
        socket.addMembership('239.255.255.250');
      } catch (e) {
      }
      socket.setBroadcast(true);
      socket.setMulticastTTL(4);

      const sendSearch = () => {
        if (found || retryCount >= maxRetries) return;
        retryCount++;
        socket.send(ssdpMsg, 1900, '239.255.255.250', (err) => {
          if (err) {
            clearTimeout(timer);
            clearTimeout(retryTimer);
            socket.close();
            reject(err);
          }
        });
        if (retryCount < maxRetries) {
          retryTimer = setTimeout(sendSearch, 2000);
        }
      };
      sendSearch();
    });
  });
}

/**
 * 从网关描述 XML 中解析 UPnP 控制 URL
 * @param {string} gatewayLocation - 网关描述文档 URL
 * @returns {Promise<Object>} { baseUrl: string, controlUrl: string, serviceType: string }
 * @throws {Error} URL 无效或找不到 WANIPConnection 服务时抛出
 */
async function getUPnPControlURL(gatewayLocation) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try { parsedUrl = new URL(gatewayLocation); } catch (e) { return reject(new Error('Invalid gateway URL')); }

    const req = http.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      method: 'GET',
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const match = data.match(/<URLBase>(.*?)<\/URLBase>/);
        const baseUrl = match ? match[1] : `${parsedUrl.protocol}//${parsedUrl.host}`;

        const serviceTypes = [
          'urn:schemas-upnp-org:service:WANIPConnection:1',
          'urn:schemas-upnp-org:service:WANIPConnection:2',
          'urn:schemas-upnp-org:service:WANPPPConnection:1'
        ];

        for (const svcType of serviceTypes) {
          const escapedType = svcType.replace(/([.:])/g, '\\$1');
          const svcRegex = new RegExp(
            `<service>[\\s\\S]*?<serviceType>${escapedType}<\\/serviceType>[\\s\\S]*?<controlURL>(.*?)<\\/controlURL>[\\s\\S]*?<\\/service>`, 'i'
          );
          const svcMatch = data.match(svcRegex);
          if (svcMatch) {
            resolve({ baseUrl, controlUrl: svcMatch[1], serviceType: svcType });
            return;
          }
        }

        const anyWanMatch = data.match(/<service>[\s\S]*?<serviceType>(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d+)<\/serviceType>[\s\S]*?<controlURL>(.*?)<\/controlURL>[\s\S]*?<\/service>/i);
        if (anyWanMatch) {
          resolve({ baseUrl, controlUrl: anyWanMatch[2], serviceType: anyWanMatch[1] });
          return;
        }

        reject(new Error('WANIPConnection service not found in gateway description'));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout fetching gateway description')); });
    req.end();
  });
}

/**
 * 通过 UPnP 添加端口映射
 * @param {number} internalPort - 内部端口
 * @param {number} externalPort - 外部端口
 * @param {string} description - 端口映射描述
 * @returns {Promise<Object>} 成功返回 { success: true, externalPort, internalPort, localIP }，
 *   失败返回 { success: false, error } 或抛出异常
 * @throws {Error} 路由器拒绝映射时抛出（含错误码 725/718/606 等）
 */
async function upnpAddPortMapping(internalPort, externalPort, description) {
  try {
    const gateway = await discoverUPnPGateway();
    const { baseUrl, controlUrl, serviceType } = await getUPnPControlURL(gateway.location);
    const svcType = serviceType || 'urn:schemas-upnp-org:service:WANIPConnection:1';
    const localIP = getLocalIPForGateway(gateway.address);

    let parsedBase;
    try { parsedBase = new URL(baseUrl); } catch (e) { return { success: false, error: 'Invalid base URL' }; }
    const soapBody = [
      '<?xml version="1.0"?>',
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
      '<s:Body>',
      `<u:AddPortMapping xmlns:u="${svcType}">`,
      '<NewRemoteHost></NewRemoteHost>',
      `<NewExternalPort>${externalPort}</NewExternalPort>`,
      '<NewProtocol>TCP</NewProtocol>',
      `<NewInternalClient>${localIP}</NewInternalClient>`,
      `<NewInternalPort>${internalPort}</NewInternalPort>`,
      '<NewEnabled>1</NewEnabled>',
      `<NewPortMappingDescription>${description || 'VersePC'}</NewPortMappingDescription>`,
      '<NewLeaseDuration>0</NewLeaseDuration>',
      '</u:AddPortMapping>',
      '</s:Body>',
      '</s:Envelope>'
    ].join('');

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: parsedBase.hostname,
        port: parsedBase.port || 80,
        path: controlUrl,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': `"${svcType}#AddPortMapping"`,
          'Content-Length': Buffer.byteLength(soapBody)
        },
        timeout: 10000
      }, (res) => {
        if (res.statusCode === 200 || res.statusCode === 204) {
          ctx.network.upnpMappings.set(externalPort, { internalPort, description, localIP });
          resolve({ success: true, externalPort, internalPort, localIP });
        } else {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            const errorCodeMatch = data.match(/<errorCode>(\d+)<\/errorCode>/);
            const errorDescMatch = data.match(/<errorDescription>(.*?)<\/errorDescription>/);
            const errorCode = errorCodeMatch ? errorCodeMatch[1] : res.statusCode;
            const errorDesc = errorDescMatch ? errorDescMatch[1] : data.substring(0, 200);

            if (errorCode === '725') {
              reject(new Error('Router does not allow permanent port mapping (error 725). Try with a lease duration.'));
            } else if (errorCode === '718') {
              reject(new Error('Port mapping conflict: another mapping already exists for this port (error 718).'));
            } else if (errorCode === '606') {
              reject(new Error('Router rejected the mapping (error 606). Try a different external port.'));
            } else {
              reject(new Error(`UPnP AddPortMapping failed: ${errorCode} ${errorDesc}`));
            }
          });
        }
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(soapBody);
      req.end();
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 通过 UPnP 删除端口映射
 * @param {number} externalPort - 外部端口
 * @returns {Promise<Object>} 成功返回 { success: true }，失败返回 { success: false, error } 或抛出异常
 */
async function upnpDeletePortMapping(externalPort) {
  try {
    const gateway = await discoverUPnPGateway();
    const { baseUrl, controlUrl, serviceType } = await getUPnPControlURL(gateway.location);
    const svcType = serviceType || 'urn:schemas-upnp-org:service:WANIPConnection:1';

    let parsedBase;
    try { parsedBase = new URL(baseUrl); } catch (e) { return { success: false, error: 'Invalid base URL' }; }
    const soapBody = [
      '<?xml version="1.0"?>',
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
      '<s:Body>',
      `<u:DeletePortMapping xmlns:u="${svcType}">`,
      '<NewRemoteHost></NewRemoteHost>',
      `<NewExternalPort>${externalPort}</NewExternalPort>`,
      '<NewProtocol>TCP</NewProtocol>',
      '</u:DeletePortMapping>',
      '</s:Body>',
      '</s:Envelope>'
    ].join('');

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: parsedBase.hostname,
        port: parsedBase.port || 80,
        path: controlUrl,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': `"${svcType}#DeletePortMapping"`,
          'Content-Length': Buffer.byteLength(soapBody)
        },
        timeout: 10000
      }, (res) => {
        if (res.statusCode === 200 || res.statusCode === 204) {
          ctx.network.upnpMappings.delete(externalPort);
          resolve({ success: true });
        } else {
          reject(new Error(`UPnP DeletePortMapping failed: ${res.statusCode}`));
        }
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(soapBody);
      req.end();
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 通过公共 IP 查询服务获取本机公网 IP
 * @returns {Promise<string|null>} 公网 IPv4 地址，获取失败返回 null
 */
async function getPublicIP() {
  const services = [
    'https://api.ipify.org?format=json',
    'https://api64.ipify.org?format=json',
    'https://ifconfig.me/ip'
  ];

  for (const service of services) {
    try {
      const result = await new Promise((resolve, reject) => {
        const client = service.startsWith('https') ? https : http;
        const req = client.get(service, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json.ip);
            } catch {
              resolve(data.trim());
            }
          });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
      });
      if (result && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(result)) {
        return result;
      }
    } catch (e) { continue; }
  }
  return null;
}

/* Minecraft 协议 VarInt 编解码 */

/**
 * 将整数编码为 Minecraft 协议 VarInt 字节序列
 * @param {number} value - 待编码整数
 * @returns {Buffer} VarInt 字节 Buffer
 */
function encodeVarInt(value) {
  const bytes = [];
  do {
    let temp = value & 0x7F;
    value >>>= 7;
    if (value !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (value !== 0);
  return Buffer.from(bytes);
}

/**
 * 从 Buffer 偏移处解码 Minecraft 协议 VarInt
 * @param {Buffer} buffer - 数据 Buffer
 * @param {number} offset - 起始偏移
 * @returns {Object} { value: number, bytesRead: number }
 */
function decodeVarInt(buffer, offset) {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  while (true) {
    const b = buffer[offset + bytesRead];
    result |= (b & 0x7F) << shift;
    bytesRead++;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result, bytesRead };
}

/**
 * 对 MC 服务器执行 Ping 协议握手，获取状态信息（版本、在线人数、描述等）
 * @param {string} host - 服务器主机
 * @param {number} [port=25565] - 服务器端口
 * @param {number} [timeout=5000] - 超时时间（毫秒）
 * @returns {Promise<Object>} 在线返回 { online: true, version, protocol, players, description, favicon, latency }，
 *   离线返回 { online: false, error }
 */
async function mcPing(host, port = 25565, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);

    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(result);
    };

    socket.on('timeout', () => finish({ online: false, error: 'timeout' }));
    socket.on('error', (err) => finish({ online: false, error: err.message }));

    socket.connect(port, host, () => {
      const pingStart = Date.now();

      /* 握手包：协议版本 772 + 主机名 + 端口 + 下一个状态 1（Status） */
      const handshakeData = [
        encodeVarInt(0),
        encodeVarInt(772),
        encodeVarInt(host.length),
        Buffer.from(host, 'utf8'),
        Buffer.from([(port >> 8) & 0xFF, port & 0xFF]),
        encodeVarInt(1)
      ];
      const handshakeBody = Buffer.concat(handshakeData);
      const handshakePacket = Buffer.concat([encodeVarInt(handshakeBody.length), handshakeBody]);

      /* Status 请求包（packet id 0） */
      const statusBody = encodeVarInt(0);
      const statusPacket = Buffer.concat([encodeVarInt(statusBody.length), statusBody]);

      socket.write(handshakePacket);
      socket.write(statusPacket);

      /* Ping 包（packet id 1，携带时间戳用于计算延迟） */
      const tsBuf = Buffer.alloc(8);
      tsBuf.writeBigInt64BE(BigInt(pingStart));
      const pingPkt = Buffer.concat([Buffer.from([9, 1]), tsBuf]);

      socket.write(pingPkt);

      let data = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        data = Buffer.concat([data, chunk]);

        try {
          let offset = 0;
          const packetLen = decodeVarInt(data, offset);
          offset += packetLen.bytesRead;

          const packetId = decodeVarInt(data, offset);
          offset += packetId.bytesRead;

          if (packetId.value === 0) {
            const jsonLen = decodeVarInt(data, offset);
            offset += jsonLen.bytesRead;

            if (offset + jsonLen.value <= data.length) {
              const jsonStr = data.slice(offset, offset + jsonLen.value).toString('utf8');
              const latency = Date.now() - pingStart;

              try {
                const status = JSON.parse(jsonStr);
                finish({
                  online: true,
                  version: status.version?.name || 'Unknown',
                  protocol: status.version?.protocol || 0,
                  players: {
                    online: status.players?.online || 0,
                    max: status.players?.max || 0,
                    sample: status.players?.sample || []
                  },
                  description: typeof status.description === 'string'
                    ? status.description
                    : JSON.stringify(status.description),
                  favicon: status.favicon || null,
                  latency: latency
                });
              } catch (e) {
                finish({ online: false, error: 'parse error' });
              }
            }
          }
        } catch (e) {
        }
      });
    });
  });
}

module.exports = {
  getLocalIPForGateway,
  discoverUPnPGateway,
  _ssdpSearch,
  getUPnPControlURL,
  upnpAddPortMapping,
  upnpDeletePortMapping,
  getPublicIP,
  encodeVarInt,
  decodeVarInt,
  mcPing,
  // 清理所有 UPnP 映射，应用退出时调用
  async cleanupAllUPnPMappings() {
    const mappings = Array.from(ctx.network.upnpMappings.keys());
    for (const extPort of mappings) {
      try { await upnpDeletePortMapping(extPort); } catch (e) {}
    }
  }
};
