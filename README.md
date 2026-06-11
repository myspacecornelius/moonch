# moonch

## Job Search Toolkit

This repo doubles as a personal job-search assistant powered by Claude Code: resume
tailoring, application-form answers, cover letters, follow-ups, and a pipeline tracker.
Start with **[jobsearch/README.md](jobsearch/README.md)** — first step is making this repo
private, then running `/job-setup` in Claude Code.

---

# Web Crawler Project

A versatile web crawler that demonstrates different web scraping techniques using Python. This project includes capabilities for:
- REST API data fetching
- Basic web scraping with BeautifulSoup
- JavaScript-rendered content scraping with Selenium

## Project Structure
```
web_crawler/
├── README.md           # Project documentation
├── requirements.txt    # Python package dependencies
├── setup.sh           # Installation script
└── src/
    ├── api_crawler.py # Main crawler implementation
    └── example.py     # Usage examples
```

## Installation

1. Make the setup script executable:
```bash
chmod +x setup.sh
```

2. Run the setup script:
```bash
./setup.sh
```

This will:
- Install Python3 (via Homebrew if needed)
- Install Homebrew (if not already installed)
- Install pip3
- Create a virtual environment
- Install required packages in the virtual environment

3. Set up your Apollo.io API key:
- Sign up for an Apollo.io account and get your API key
- Copy the .env.example file to .env:
  ```bash
  cp .env.example .env
  ```
- Edit the .env file and replace 'your_api_key_here' with your actual Apollo.io API key

4. Activate the virtual environment:
```bash
source venv/bin/activate
```

## Features

### 1. API Data Fetching
- Simple REST API interaction
- JSON response handling
- Error handling and logging

### 2. Web Scraping with BeautifulSoup
- HTML content fetching
- DOM parsing and navigation
- Content extraction

### 3. JavaScript-Rendered Content with Selenium
- Headless browser automation
- Dynamic content scraping
- Resource cleanup

## Usage

Run the example script to see the crawler in action:
```bash
python3 src/example.py
```

This will demonstrate:
1. Fetching data from a REST API
2. Scraping static web content
3. Scraping JavaScript-rendered content

## Requirements
- Python 3.x
- Chrome/Chromium (for Selenium)
- Packages listed in requirements.txt

## Error Handling
The crawler includes comprehensive error handling and logging for:
- Network requests
- API responses
- HTML parsing
- Browser automation

## Best Practices
- Resource cleanup with context managers
- Type hints for better code maintainability
- Configurable logging
- Modular design
