from api_crawler import WebCrawler
import json
import os


def example_apollo_api_call():
    """Example of fetching data from Apollo.io API"""
    # You need to set your Apollo API key in an environment variable
    api_key = os.getenv('APOLLO_API_KEY')
    if not api_key:
        print("Error: APOLLO_API_KEY environment variable not set")
        return

    # Example search for organizations
    headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Authorization': f'Bearer {api_key}'
    }
    
    # Example query for organizations
    payload = {
        "api_key": api_key,
        "q_organization_domains": ["example.com"],
        "page": 1,
        "per_page": 1
    }

    with WebCrawler() as crawler:
        try:
            # Search organizations using Apollo API
            data = crawler.fetch_api_data(
                'https://api.apollo.io/v1/organizations/search',
                headers=headers,
                method='POST',
                json=payload
            )
            print("\nApollo.io API Response:")
            print(json.dumps(data, indent=2))
        except Exception as e:
            print(f"Error fetching Apollo.io API data: {e}")

def example_web_scraping():
    """Example of web scraping with BeautifulSoup"""
    # Using Python's official website as an example
    with WebCrawler() as crawler:
        try:
            # Fetch and parse the page
            html_content = crawler.fetch_page_content('https://www.python.org')
            soup = crawler.parse_html(html_content)
            
            # Get the latest news titles
            news_items = soup.select('.blog-widget li')
            
            print("\nLatest Python News:")
            for item in news_items[:3]:  # Show first 3 news items
                link = item.find('a')
                if link:
                    title = link.text.strip()
                    print(f"- {title}")
        except Exception as e:
            print(f"Error scraping web content: {e}")

def example_selenium_scraping():
    """Example of scraping JavaScript-rendered content with Selenium"""
    # Using GitHub's trending page as an example
    with WebCrawler(use_selenium=True) as crawler:
        try:
            # Fetch and parse the page
            html_content = crawler.fetch_page_content(
                'https://github.com/trending',
                use_selenium=True
            )
            soup = crawler.parse_html(html_content)
            
            # Get trending repository names
            repos = soup.select('h2.h3.lh-condensed')
            
            print("\nTrending GitHub Repositories:")
            for repo in repos[:3]:  # Show first 3 repositories
                link = repo.find('a')
                if link:
                    name = link.text.strip()
                    print(f"- {name}")
        except Exception as e:
            print(f"Error scraping with Selenium: {e}")

if __name__ == "__main__":
    print("Running Web Crawler Examples...")
    
    # Run examples
    example_apollo_api_call()
    example_web_scraping()
    example_selenium_scraping()
