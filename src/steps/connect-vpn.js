const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const path = require('path');


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

  // Connect to MySQL database
  context.connections.mysql = await mysql.createPool({
    host: process.env.MYSQL_HOST,
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