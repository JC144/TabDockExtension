# Tab Dock Extension
[Official website](https://tabdock.org/)

![Presentation of Tab Dock](http://jc.vasselon.com/TabDockWebsite/Webdock3.gif)

## Why?
Because I use too many tabs and I always lose them.

I'm not alone, I see you who couldn't find your Google Meet tab!

## The journey
Well...

I thought it was going to be easy. I just had to extend the browser in the end.

But Internet Explorer era has ended.

I had to inject the dock in the website displayed. It has been a wonderful journey where I discovered Shadow dom, CSS, improved my javascript and lost a lot of night on a synchronisation issue.

## What can it do?
* **Dynamic Tab Dock:** Group all your tabs from the same Web Application at the bottom of your browser window. 
* **Easy Navigation:** Click on any tab in the dock to instantly switch to it, quickly check your openned tab and remove the ones you don't need anymore.
* **Smooth Animations:** Experience delightful animations. The web doesn't have to be rigid.
* **Open Source:** All code is open-source, feel free to bring your ideas and improvements.
* **No tracking:** Everything stays on your computer.

## How does it work?
* **Hover to Expand:** Move your mouse to the bottom of the window to reveal the dock.
* **Group and Navigate:** Icons in the dock represent different web applications. Hover over an icon to view all open tabs from that web application, then click to switch to the desired tab.
* **Seamless Integration:** The dock is automatically injected into each website you visit, ensuring a consistent and integrated experience.

## It's amazing! How can I install it?
Yes of course, the best way is to go on the official page to get your store link.

If you want to use the source, rename manifest.YOURBROWSER.json into manifest.json and use the related procedure.

## It's amazing! How can I install it?
Yes of course, the best way is to go on [the official page](https://tabdock.org/) to get your store link.

If you want to use the source, build the extension for your browser (see below).

## How can I build it?
A PowerShell script does the packaging for you:

```powershell
.\build.ps1            # build both browsers
.\build.ps1 chrome     # Chrome only
.\build.ps1 firefox    # Firefox only
```

For each browser it creates `dist/<browser>/` with all the extension files and the right manifest (`manifest.chrome.json` is Manifest V3, `manifest.firefox.json` is Manifest V2), plus a store-ready archive `dist/tabdock-<browser>-<version>.zip` (Chrome Web Store / AMO).

To test it locally:
* **Chrome:** go to `chrome://extensions`, enable Developer mode and "Load unpacked" the `dist/chrome` folder.
* **Firefox:** go to `about:debugging#/runtime/this-firefox` and "Load Temporary Add-on" with any file inside the `dist/firefox` folder.

## Can I fork it?
As long as the project stays open-source, you do as you want!

## How can I support you?
These crazy projects takes time and tokens.

[A tip is always appreciated](https://www.paypal.com/donate/?hosted_button_id=XC7MKUJ7V94QY), it's the best recognition to see someone offering you a beer because you made a tool he use!
