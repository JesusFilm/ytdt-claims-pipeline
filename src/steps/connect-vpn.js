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
 * Retried, because the resolver can still be unready in the second or two after
 * the tunnel reports itself up, and a transient miss should not cost a ten
 * minute run. Returns null once the attempts are spent; the caller decides what
 * that means.
 */
async function resolveInVpc(host, { timeoutMs = 5000, attempts = 3, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const address = await resolveOnce(host, timeoutMs, attempt, attempts);
    if (address) return address;
    if (attempt < attempts) await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

async function resolveOnce(host, timeoutMs, attempt, attempts) {
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
    console.log(`VPC lookup of ${host} failed, attempt ${attempt}/${attempts} (${error.message})`);
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

  // The VPC resolver is the only authority on where RDS is. Its private address
  // is not stable: it was 10.0.5.178 on 2026-10-20 and 10.0.5.218 two days
  // later, so anything written down ages into a wrong answer.
  //
  // Nothing is provisioned as a fallback for that reason. MYSQL_IP stays
  // readable as a break-glass override for the case where the resolver itself
  // is down and someone needs a run to go through now; provisioning never sets
  // it, so there is no pin to go stale on its own.
  //
  // With neither, fail here. Using the hostname as given would resolve through
  // public DNS to the endpoint's PUBLIC address, which cannot serve us — the
  // connection then dies later as a timeout that reads like a VPN fault.
  let host = process.env.MYSQL_HOST;
  if (!skipVpn) {
    const resolved = await resolveInVpc(process.env.MYSQL_HOST);
    if (resolved) {
      console.log(`MySQL endpoint resolved in-VPC to ${resolved}`);
      host = resolved;
    } else if (process.env.MYSQL_IP) {
      console.log(`VPC resolver gave no answer; using the MYSQL_IP override ${process.env.MYSQL_IP}`);
      console.log('This is a manual override and may be stale. Unset it once the resolver works.');
      host = process.env.MYSQL_IP;
    } else {
      throw new Error(
        `Could not resolve ${process.env.MYSQL_HOST} via the VPC resolver ${VPC_RESOLVER} ` +
        'after 3 attempts. The tunnel may be down, or the resolver unreachable. ' +
        'Set MYSQL_IP to the RDS private address to force a run through.'
      );
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