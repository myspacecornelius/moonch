import os
# api_crawler.py
import requests
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from webdriver_manager.chrome import ChromeDriverManager
import logging
from typing import Dict, Any, Optional

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class WebCrawler:
    def __init__(self, use_selenium: bool = False):
        """
        Initialize the web crawler.
        
        Args:
            use_selenium (bool): Whether to use Selenium for JavaScript-rendered content
        """
        self.session = requests.Session()
        self.driver = None
        if use_selenium:
            self._setup_selenium()

    def _setup_selenium(self):
        """Set up Selenium WebDriver with Chrome"""
        try:
            chrome_options = Options()
            chrome_options.add_argument('--headless')  # Run in headless mode
            chrome_options.add_argument('--no-sandbox')
            chrome_options.add_argument('--disable-dev-shm-usage')
            
            service = Service(ChromeDriverManager().install())
            self.driver = webdriver.Chrome(service=service, options=chrome_options)
            logger.info("Selenium WebDriver initialized successfully")
        except Exception as e:
            logger.error(f"Failed to initialize Selenium WebDriver: {str(e)}")
            raise

    def fetch_api_data(
        self, 
        url: str, 
        method: str = 'GET',
        params: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        json: Optional[Dict[str, Any]] = None
    ) -> Dict:
        """
        Fetch data from a REST API endpoint.
        
        Args:
            url (str): The API endpoint URL
            method (str): HTTP method (GET, POST, etc.)
            params (Dict[str, Any], optional): Query parameters
            headers (Dict[str, str], optional): Request headers
            json (Dict[str, Any], optional): JSON payload for POST requests
            
        Returns:
            Dict: The JSON response from the API
        """
        try:
            logger.info(f"Fetching API data from: {url}")
            response = self.session.request(
                method=method,
                url=url,
                params=params,
                headers=headers,
                json=json
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            logger.error(f"Error fetching API data: {str(e)}")
            raise

    def fetch_page_content(self, url: str, use_selenium: bool = False) -> str:
        """
        Fetch the HTML content of a webpage.
        
        Args:
            url (str): The webpage URL
            use_selenium (bool): Whether to use Selenium for JavaScript-rendered content
            
        Returns:
            str: The HTML content of the page
        """
        try:
            if use_selenium and self.driver:
                self.driver.get(url)
                return self.driver.page_source
            else:
                response = self.session.get(url)
                response.raise_for_status()
                return response.text
        except Exception as e:
            logger.error(f"Error fetching page content: {str(e)}")
            raise

    def parse_html(self, html_content: str) -> BeautifulSoup:
        """
        Parse HTML content using BeautifulSoup.
        
        Args:
            html_content (str): The HTML content to parse
            
        Returns:
            BeautifulSoup: Parsed HTML object
        """
        return BeautifulSoup(html_content, 'lxml')

    def close(self):
        """Clean up resources"""
        if self.driver:
            self.driver.quit()
        self.session.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
