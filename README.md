<p align="center">
  <img src="icons/icon128.png" width="96" height="96" alt="LinkedIn Commute Time" />
</p>

# LinkedIn Commute Time

A Chrome extension that shows commute times directly on job cards as you browse LinkedIn, and keeps track of jobs you view or apply to.

## What it does

When looking for jobs on LinkedIn, checking commute times for dozens of listings means constantly opening Google Maps and typing in city names. This extension checks your travel time automatically and attaches a small badge (for example, `35m` or `1h 10m`) to each job card on the search page.

It also tracks your job hunting activity so you don't lose track of where you've applied.

## Main features

### 1. Auto-Calculate (Maps API)
Instead of preparing a file yourself, you can let the extension calculate travel times automatically:
- Supports OpenRouteService (free tier: 2000 directions/day, 3000 geocoding requests/day, no credit card needed)
- Supports Google Maps API (requires billing, supports transit/trains)
- Comes bundled with coordinates for over 6,500 cities across 32 countries (Europe and the Americas), so it only needs 1 API request per city instead of geocoding everything from scratch
- Transport options: car, cycling, walking, or transit (which can be activated only via Google Maps)
- Shows a live log of calculations as they happen
- Lets you export the calculated times as a CSV file so you can calculate once and reuse the file without using your API quota again

### 2. Manual CSV Upload
If you already have commute data (from NS, 9292, or a previous export), you can just upload a `.csv` file:
- File format: `Origin,Destination,Travel_Time`
- Automatically detects your home city from the file and treats it as a 0m commute
- Runs 100% locally from browser storage with zero API calls

### 3. Application Tracker
Works on job search results and on the Jobs home page (including "More jobs for you"). Every job is tracked by its LinkedIn job ID.
- Thin color bar on each job card:
  - Faint green: jobs you haven't opened; stronger green with a **New** tag: first seen today
  - Amber: jobs you viewed or saved
  - Red (faded): jobs you applied to
- Date tag next to LinkedIn's own status, e.g. `Applied 28 Sep` or `Viewed 28 Sep ×3`. Hover it for the full history (every day you opened the job, when it was saved, when it was first seen)
- `Applied before 12 Aug`: you already applied to the same title at the same company under an older posting
- `↻ 3 wks`: the posting has kept showing up in your lists for weeks (often hard to fill or repeatedly reposted)
- Follow-up reminder: applications turn orange after 14 days and are listed in the popup
- Commute badges are colored by duration (up to 45 min / up to 90 min / longer)
- Popup settings: fade or hide applied jobs, fade jobs over a maximum commute, turn the New tag on/off
- Export your history to CSV (dates, every view date, link to the job)

If LinkedIn changes its layout and the extension can't find job cards on a page that clearly lists jobs, the toolbar icon shows a red **!**. See `tests/README.md` for how to check and fix it.

### 4. Privacy
Everything is stored locally on your machine using Chrome's local storage. There are no external tracking servers, analytics, or accounts.

## Installation

The extension is loaded in Developer Mode:

1. Download `linkedin_commute_extension.zip` from the Releases section and unzip it.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable "Developer mode" in the top right.
4. Click "Load unpacked" and select the unzipped folder.
5. Open LinkedIn Jobs.

## Setup

Open the extension popup from your toolbar and choose how you want to set it up:

### Method A: Calculate with Maps API (easiest)
1. In the popup, open "Commute setup", then the "Auto-Calculate" tab.
2. Choose your provider (OpenRouteService is free; sign up at openrouteservice.org to get a key).
3. Paste your API key and enter your home address or postal code.
4. Pick your country and travel method, then click "Fetch & Apply".
5. When it finishes, click "Export CSV" if you want to keep a local backup of the times.

### Method B: Manual CSV
1. In the popup, open "Commute setup", then the "Upload File" tab.
2. Set your home city.
3. Upload a CSV file structured like this:
   ```csv
   Origin,Destination,Travel_Time
   Rotterdam,Amsterdam,45m
   Rotterdam,Utrecht,30m
   Rotterdam,Den Haag,25m
   ```

## Supported countries for auto-calculation

Argentina, Austria, Belgium, Brazil, Canada, Chile, Colombia, Croatia, Czech Republic, Denmark, Finland, France, Germany, Greece, Hungary, Ireland, Italy, Luxembourg, Mexico, Netherlands, Norway, Poland, Portugal, Romania, Serbia, Slovakia, Slovenia, Spain, Sweden, Switzerland, United Kingdom, United States.

## License

MIT
