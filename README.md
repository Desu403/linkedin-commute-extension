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
- Color-codes job cards on LinkedIn:
  - Green border: Jobs you haven't opened yet
  - Yellow border: Jobs you viewed or saved
  - Red border: Jobs you applied to
- Automatically records the date you applied and shows a badge next to the job title
- Lets you export your application history to CSV (title, company, applied date, viewed date, saved date)

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
1. In the popup, open the "Auto-Calculate" tab.
2. Choose your provider (OpenRouteService is free; sign up at openrouteservice.org to get a key).
3. Paste your API key and enter your home address or postal code.
4. Pick your country and travel method, then click "Fetch & Apply".
5. When it finishes, click "Export CSV" if you want to keep a local backup of the times.

### Method B: Manual CSV
1. In the popup, stay on the "Upload File" tab.
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
