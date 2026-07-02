# Secure Host-Side Gateway Setup (Squid Proxy for Windows)

This guide isolates a VMware Workstation Ubuntu guest in **Host-Only** mode and routes allowed web requests through a **Squid Proxy** running on your Windows host. All unapproved traffic is dropped and logged.

---

## Step 1: Isolate the VMware Network

To ensure the coding agent cannot bypass your host's proxy, strip the VM of its direct internet paths.

1. Open **VMware Workstation**.
2. Go to **VM** > **Settings** > **Network Adapter**.
3. Select **Host-only: A private network shared with the host**.
4. Click **OK**.

---

## Step 2: Install Squid on Windows

1. Download the Windows native Squid MSI installer provided by [Diladele Squid for Windows](https://www.diladele.com/squid/).
2. Run the `.msi` file and complete the setup wizard. By default, it installs to `C:\Squid`.
3. Open Windows **Services** (`services.msc`), locate the **Squid** service, and click **Stop**. You must stop it before modifying configuration files.

---

## Step 3: Create your Domain Whitelist

Create a plain text file containing the exact domains or patterns your agent is permitted to visit.

1. Open Notepad as an Administrator.
2. Add your allowed platforms (one domain per line). Use a leading dot (`.`) to match subdomains:
   ```text
   .github.com
   .githubusercontent.com
   .api.openai.com
   .pypi.org
   .pythonhosted.org
   ```
3. Save the file exactly as `C:\Squid\etc\whitelist.txt`.

---

## Step 4: Configure Squid (`squid.conf`)

1. Open `C:\Squid\etc\squid.conf` in a text editor as an Administrator.
2. Locate the top of the **Access Lists (ACL)** section and add your custom whitelist rules:

   ```text
   # Define the whitelist text file
   acl allowed_domains dstdomain "C:/Squid/etc/whitelist.txt"

   # Define your VMware Host-Only network range (Adjust subnet if yours differs)
   acl vm_network src 192.168.126.0/24
   ```

3. Scroll down to the `http_access` section. Insert your allow/deny rules **above** any generic defaults:

   ```text
   # 1. Allow the VM to access the whitelisted domains
   http_access allow vm_network allowed_domains

   # 2. Deny everything else from the VM
   http_access deny vm_network
   ```

4. Save and close the file.
5. Open Windows **Services** and **Start** the Squid service.

---

## Step 5: Route Ubuntu Traffic Through the Proxy

Inside your Ubuntu VM, you must instruct your terminal tools and coding environment to communicate via the Windows Host-only IP address (usually `.1` of your VMnet range on port `3128`).

Open a terminal in Ubuntu and append the proxy configurations to your environment profile:

```bash
# Open profile configurations
echo 'export http_proxy="http://192.168.126.1:3128"' >> ~/.bashrc
echo 'export https_proxy="http://192.168.126.1:3128"' >> ~/.bashrc

# Apply changes to current session
source ~/.bashrc
```

---

## Step 6: Monitor and Audit Blocked Domains

To audit what your agent is doing or troubleshoot missing dependencies, open the log file located on your Windows host at:
`C:\Squid\var\log\squid\access.log`

### Reading the Log Entries

Squid writes a line for every single connection attempt.

- **Example of a REJECTED Request (To be whitelisted?):**

  ```text
  1719332400.123    15 192.168.126.130 TCP_DENIED/403 3940 CONNECT registry.npmjs.org:443 - HIER_NONE/- text/html
  ```

  - _Analysis_: The agent tried to access `registry.npmjs.org`. Because it saw `TCP_DENIED/403`, the request failed. If your agent needs npm packages, copy `registry.npmjs.org` and paste it into `C:\Squid\etc\whitelist.txt`.

- **Example of an ALLOWED Request:**
  ```text
  1719332405.456   230 192.168.126.130 TCP_TUNNEL/200 5432 CONNECT ://openai.com - HIER_DIRECT/23.212.4.12 -
  ```

  - _Analysis_: The connection to OpenAI succeeded (`TCP_TUNNEL/200`) because it matched your whitelist.

_(Note: Every time you add a domain to `whitelist.txt`, restart the Squid service in Windows for the changes to apply)._
