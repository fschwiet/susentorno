To fix this issue in VMware on a Windows host, you need to stop VMware from automatically pushing the host's high-DPI scaling rules down to the Ubuntu guest.

Follow these steps to permanently lock your display configuration.

## Step 1: Change VMware App Compatibility Settings

This prevents Windows from scaling the VMware player itself, which causes blurry fonts and resetting screens.

1. Close your **VMware Workstation / Player**.
2. Right-click the **VMware icon** on your Windows desktop (or Start Menu) and select **Properties**.
3. Go to the **Compatibility** tab.
4. Click on **Change high DPI settings**.
5. Check the box under **High DPI scaling override**.
6. Set the drop-down menu to **Application**.
7. Click **OK**, then **Apply**.

## Step 2: Disable Automatic Scaling in VMware

1. Launch VMware and open your **Ubuntu VM settings** (do not power it on yet).
2. Go to **Hardware** > **Display**.
3. Under the **Display scaling** section, **uncheck** the box that says **"Automatically adjust user interface size in the guest"**.
4. (Optional) Under **Monitors**, change "Use host setting for monitors" to **Specify monitor settings** and input your exact host resolution (e.g., 1920x1080 or 3840x2160).
5. Click **Save**.

## Step 3: Turn Off AutoFit Window

1. Power on your Ubuntu VM.
2. In the top VMware menu bar, click on **View**.
3. Hover over **Autofit Guest** and **uncheck** it.
4. Ensure **Autofit Window** is also turned off if you want a strictly locked size.

## Step 4: Set the Scale Permanently in Ubuntu

1. Inside Ubuntu, open your terminal (`Ctrl` + `Alt` + `T`).
2. Run this command to prevent the GNOME desktop from automatically adjusting to hardware plug-and-play changes:
   ```bash
   gsettings set org.gnome.desktop.interface scaling-factor 2
   ```
   _(Note: Change `2` to `1` for 100%, or `2` for 200% text and icon scaling)._
