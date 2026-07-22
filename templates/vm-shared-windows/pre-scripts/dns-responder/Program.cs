using System.Net;
using System.Net.Sockets;

// Catch-all DNS stub: answers every A query with the host proxy IP so the guest
// routes all names to the transparent Envoy proxy (the app connects to hostIp:443
// with SNI intact). AAAA queries get NOERROR/no-answer so callers fall back to A.
// The target IP is read from responder-config.txt next to the exe (written by
// 05-configure-network.ps1).

string exeDir = AppContext.BaseDirectory;
string configPath = Path.Combine(exeDir, "responder-config.txt");
string ipText = File.ReadAllText(configPath).Trim();
byte[] ipBytes = IPAddress.Parse(ipText).GetAddressBytes(); // 4 bytes (IPv4)

using var udp = new UdpClient(new IPEndPoint(IPAddress.Loopback, 53));
Console.WriteLine($"ConfigamatronDnsResponder: answering all A queries with {ipText}");

while (true)
{
    IPEndPoint remote = new(IPAddress.Any, 0);
    byte[] query;
    try { query = udp.Receive(ref remote); }
    catch { continue; }

    if (query.Length < 12) continue;
    byte[] response = BuildResponse(query, ipBytes);
    try { udp.Send(response, response.Length, remote); } catch { /* client gone */ }
}

static byte[] BuildResponse(byte[] q, byte[] ip)
{
    // Walk the single QNAME (labels terminated by a zero byte), then read QTYPE.
    int pos = 12;
    while (pos < q.Length && q[pos] != 0) pos += q[pos] + 1;
    int qtypePos = pos + 1;
    if (qtypePos + 3 >= q.Length) return QrEcho(q); // malformed: reply, no answers
    int qtype = (q[qtypePos] << 8) | q[qtypePos + 1];
    int questionEnd = qtypePos + 4;

    using var ms = new MemoryStream();
    ms.WriteByte(q[0]); ms.WriteByte(q[1]);          // copy transaction ID
    ms.WriteByte((byte)(0x80 | (q[2] & 0x01)));      // QR=1, preserve RD
    ms.WriteByte(0x00);                              // RA=0, RCODE=0 (NOERROR)
    ms.WriteByte(0x00); ms.WriteByte(0x01);          // QDCOUNT=1
    ushort ancount = (ushort)(qtype == 1 ? 1 : 0);   // answer only A queries
    ms.WriteByte((byte)(ancount >> 8)); ms.WriteByte((byte)ancount);
    ms.WriteByte(0x00); ms.WriteByte(0x00);          // NSCOUNT=0
    ms.WriteByte(0x00); ms.WriteByte(0x00);          // ARCOUNT=0

    ms.Write(q, 12, questionEnd - 12);               // echo the question verbatim

    if (qtype == 1)
    {
        ms.WriteByte(0xC0); ms.WriteByte(0x0C);          // NAME: pointer to offset 12
        ms.WriteByte(0x00); ms.WriteByte(0x01);          // TYPE A
        ms.WriteByte(0x00); ms.WriteByte(0x01);          // CLASS IN
        ms.WriteByte(0x00); ms.WriteByte(0x00);
        ms.WriteByte(0x00); ms.WriteByte(0x1E);          // TTL 30s
        ms.WriteByte(0x00); ms.WriteByte(0x04);          // RDLENGTH 4
        ms.Write(ip, 0, 4);                              // RDATA (the host IP)
    }
    return ms.ToArray();
}

static byte[] QrEcho(byte[] q)
{
    byte[] r = (byte[])q.Clone();
    r[2] = (byte)(0x80 | (q[2] & 0x01)); // QR=1
    r[3] = 0x00;
    return r;
}
