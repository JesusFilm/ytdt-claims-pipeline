const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const path = require('path');
const { Resolver } = require('dns').promises;

// The AWS resolver inside the Arclight VPC, reachable once the tunnel is up.
const VPC_RESOLVER = '169.254.169.253';

/**
 * Ask the VPC resolver what the RDS endpoint is, through the tunnel.
 *
 * The endpoint is split-horizon: public DNS answers with a PUBLIC address (a
 * CNAME to an ec2-* name), and only inside the VPC does the same name give the
 * private address the tunnel can reach. So the host's own resolution is not
 * usable — and worse, it looks fine.
 *
 * `getent`, `getaddrinfo` and plain `dns.resolve4()` cannot answer this either:
 * all three go through the systemd-resolved stub, which reads /etc/hosts first
 * and hands back whatever the provisioner pinned there. An explicit Resolver is
 * the only way to reach a real upstream.
 *
 * Returns null on any failure. The caller falls back to the pin, so a resolver
 * that is slow or unreachable costs a few seconds, not the run.
 */
async function resolveInVpc(host, timeoutMs = 5000) {
  const resolver = new Resolver();
  resolver.setServers([VPC_RESOLVER]);

  let timer;
  try {
    const addresses = await Promise.race([
      resolver.resolve4(host),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
    return addresses && addresses.length ? addresses[0] : null;
  } catch (error) {
    console.log(`VPC lookup of ${host} failed (${error.message}); falling back`);
    return null;
  } finally {
    clearTimeout(timer);
    resolver.cancel();
  }
}


async function connectVPN(context) {
  
  const skipVpn = ['true', '1'].includes(process.env.SKIP_VPN);
  console.log('DEBUG: SKIP_VPN =', skipVpn);

  if (skipVpn) {
    console.log('Not using VPN connection:', process.env.SKIP_VPN);

  } else {
    console.log('Spawning OpenVPN client directly');
    await new Promise((resolve, reject) => {
      const vpn = spawn('openvpn', [
        '--config', process.env.VPN_CONFIG_FILE,
        '--log', path.join(process.cwd(), 'logs', 'vpn.log')
      ]);

      vpn.on('error', reject);

      // Give VPN time to connect
      setTimeout(() => {
        console.log('VPN connection established');
        context.connections.vpnProcess = vpn;
        resolve();
      }, 5000);
    });

    // Wait a bit more for tunnel to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Prefer what the VPC resolver says over the /etc/hosts pin the provisioner
  // wrote. The pin is correct until RDS moves, and then it is silently wrong;
  // asking through the tunnel keeps working across a move. MYSQL_IP, then the
  // hostname itself, are the fallbacks.
  let host = process.env.MYSQL_HOST;
  if (!skipVpn) {
    const resolved = await resolveInVpc(process.env.MYSQL_HOST);
    if (resolved) {
      console.log(`MySQL endpoint resolved in-VPC to ${resolved}`);
      host = resolved;
    } else if (process.env.MYSQL_IP) {
      console.log(`Falling back to MYSQL_IP ${process.env.MYSQL_IP}`);
      host = process.env.MYSQL_IP;
    } else {
      console.log('No in-VPC answer and no MYSQL_IP; using the hostname as given');
    }
  }

  // Connect to MySQL database
  context.connections.mysql = await mysql.createPool({
    host,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
  });

  // Test connection
  try {
    const [rows] = await context.connections.mysql.query('SELECT 1');
    console.log(`'MySQL connected ${skipVpn? 'without':'through'} VPN`);
  } catch (error) {
    console.log('MySQL error details:', error.code, error.errno, error.address);
    throw error;
  }
}

module.exports = connectVPN;
module.exports.resolveInVpc = resolveInVpc;