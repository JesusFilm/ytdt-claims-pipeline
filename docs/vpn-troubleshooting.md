# VPN Troubleshooting

The pipeline connects to MySQL RDS through OpenVPN by spawning the `openvpn` binary directly (see `src/steps/connect-vpn.js`). The `.ovpn` file lives at `./config/vpn/client.ovpn` (gitignored).

## Rotating credentials

```bash
# from repo root, after dropping new client.ovpn into config/vpn/
gcloud compute scp config/vpn/client.ovpn ytdt-claims:/tmp/client.ovpn --zone=us-east1-b
gcloud compute ssh ytdt-claims --zone=us-east1-b --command="
  sudo mv /tmp/client.ovpn /opt/ytdt-claims-pipeline/config/vpn/client.ovpn &&
  sudo chmod 600 /opt/ytdt-claims-pipeline/config/vpn/client.ovpn
"
```

No service restart needed — next pipeline run picks it up. Code spawns openvpn fresh each run.

## Required directives in client.ovpn

The Arclight VPN server pushes `redirect-gateway def1` (full tunnel) and uses `comp-lzo` compression. A bare `.ovpn` from the provider will need these additions to work on the GCP VM:

```
comp-lzo                                       # server pushes lzo compression
redirect-gateway def1                          # send public RDS traffic via VPN
route 10.142.0.0 255.255.240.0 net_gateway     # exclude GCP VPC from VPN
```

### Why each is needed

**`comp-lzo`** — server-side has it enabled. Without it locally, the tunnel comes up but `write to TUN/TAP : Invalid argument (code=22)` errors flood `logs/vpn.log` and packets get dropped.

**`redirect-gateway def1`** — RDS host is a public AWS hostname (`*.rds.amazonaws.com`) resolving to a public IP outside the pushed `10.0.0.0/16` route. Without full-tunnel, MySQL traffic exits via the local gateway and bypasses the VPN entirely → connection times out.

**`route 10.142.0.0 255.255.240.0 net_gateway`** — full-tunnel hijacks everything, including MongoDB at `10.142.0.62` (GCP VPC internal). `net_gateway` keeps GCP VPC traffic on `ens4`, away from the tunnel.

## Running a script over the VPN by hand

The service runs as root, so its tunnel comes up. An SSH session does not:
`openvpn` needs root to create `tun0`, and a one-off script started as your
own user fails with

```
ERROR: Cannot ioctl TUNSETIFF tun: Operation not permitted (errno=1)
```

in `logs/vpn.log`. `connect-vpn.js` prints **"VPN connection established"**
after a five-second timer whether or not the tunnel came up, so the first
thing you see is that cheerful line, followed a minute later by
`MySQL error details: ETIMEDOUT`. The VPN never connected.

Run one-off scripts as root, with the service's own environment:

```bash
gcloud compute ssh ytdt-claims --zone=us-east1-b --command="sudo bash -c '
  set -a; source /etc/ytdt-claims-pipeline/.env; set +a
  cd /opt/ytdt-claims-pipeline && node my-script.js
'"
```

Put the script inside `/opt/ytdt-claims-pipeline` rather than `/tmp` — node
resolves `require` from the script's own directory, and from `/tmp` it finds
none of the app's modules.

For anything that only reads, say so to the server as well:

```js
await mysql.query('SET SESSION TRANSACTION READ ONLY');
```

The database is production. Leave the script behind only as long as you need
it, and delete it when you are done.

### The tunnel will cut the SSH session that started it

`redirect-gateway def1` is a full tunnel: the moment `connect-vpn.js` brings
`tun0` up, the VM's default route moves off `ens4` and your own SSH connection
dies mid-command —

```
Spawning OpenVPN client directly
Read from remote host 35.227.61.101: Connection reset by peer
client_loop: send disconnect: Broken pipe
```

Your script dies with the session, but `openvpn` does not. It is left orphaned
holding the routes, which means:

* the VM stops answering SSH, **and `--tunnel-through-iap` too** — the return
  traffic goes into the tunnel either way;
* the console shows "Failed to fetch / System offline" because the pipeline API
  is no longer reachable from outside, even though `systemctl` still reports the
  service active and the instance still reports `RUNNING`.

There is no way back in. The only fix is a hard power cycle:

```bash
gcloud compute instances reset ytdt-claims --zone=us-east1-b
```

Use `reset`, not `stop` + `start`: the external IP is not reserved, so
stop/start hands the VM a new one and the console's `NEXT_PUBLIC_API_URL`
(`https://35.227.61.101.nip.io`) stops resolving to it. After the reset,
confirm the tunnel is really gone before doing anything else:

```bash
gcloud compute ssh ytdt-claims --zone=us-east1-b --command="
  pgrep -af openvpn || echo 'no openvpn'
  sudo systemctl is-active ytdt-claims-pipeline
  ip route | head -3            # default must be via ens4, no tun0
"
curl -s https://35.227.61.101.nip.io/api/health
```

To avoid it in the first place, detach the script from the SSH session and
always tear the tunnel down yourself:

```bash
gcloud compute ssh ytdt-claims --zone=us-east1-b --command="sudo bash -c '
  set -a; source /etc/ytdt-claims-pipeline/.env; set +a
  cd /opt/ytdt-claims-pipeline
  setsid nohup node my-script.js > /tmp/my-script.log 2>&1 < /dev/null &
'"
# reconnect and read /tmp/my-script.log; the tunnel drop no longer kills it
```

```js
try {
  // ... queries
} finally {
  await mysql.end();
  process.exit(0);   // kills the openvpn child connect-vpn.js spawned
}
```

A pipeline run tears its own tunnel down when it finishes. A hand-run script
has to do the same, or it strands the VM.

## Diagnostic commands

Live tunnel + routes:
```bash
gcloud compute ssh ytdt-claims --zone=us-east1-b --command="
  sudo tail -40 /opt/ytdt-claims-pipeline/logs/vpn.log
  echo '---ROUTES---'
  ip route
"
```

What to look for in `vpn.log`:
- `Initialization Sequence Completed` — tunnel is up
- `write to TUN/TAP : Invalid argument` — missing `comp-lzo`
- `WARNING: 'comp-lzo' is present in remote config but missing in local` — same
- `Options error: option 'route' cannot be used in this context` — caused by `route-nopull`; remove it

What to look for in `ip route` (when VPN is up):
- `default via 10.142.0.1 dev ens4` — should stay (Mongo path)
- `10.0.0.0/16 via 192.168.2.5 dev tun0` — RDS via VPN ✓
- `10.142.0.0/20 via 10.142.0.1` — VPC excluded from VPN ✓
- `0.0.0.0/1 via 192.168.2.5 dev tun0` — public traffic via VPN ✓

## Pipeline service

```bash
sudo systemctl status ytdt-claims-pipeline
sudo journalctl -u ytdt-claims-pipeline -f
```

Ignore `openvpn-client@client.service` and `openvpn.service` — the pipeline doesn't use them.