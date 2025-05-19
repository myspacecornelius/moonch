#!/bin/bash

echo "Installing Python3..."
    # simple conditional check to see if it's installed, and a proceeeding check to see if Homebrew is installed (with conditional installs)

if ! command -v python3 &> /dev/null; then
    
    # Install Python3 using Homebrew
    echo "Python3 not found. Installing..."
    
    # F check if Homebrew is installed
    if ! command -v brew &> /dev/null; then
        echo "Installing Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    else
        echo "Homebrew already installed"
    fi
    
    # Install Python3
    brew install python3
else
    echo "Python3 already installed"
fi

# Install pip3 (pip3 is a program that installs Python packages; sometimes just called pip or denoted 
# as pip3, which is the version of pip for Python 3)
if ! command -v pip3 &> /dev/null; then
    echo "Installing pip3..."
    curl https://bootstrap.pypa.io/get-pip.py -o get-pip.py
    python3 get-pip.py
    rm get-pip.py
else
    echo "pip3 already installed"
fi

# Create and activate virtual environment
echo "Creating virtual environment..."
python3 -m venv venv

# Activate virtual environment (this syntax works for bash/zsh)
echo "Activating virtual environment..."
source venv/bin/activate

# Install required packages in the virtual environment
echo "Installing required packages..."
pip install -r requirements.txt

echo "Setup complete! 🎉"
echo ""
echo "To use the web crawler:"
echo "1. Activate the virtual environment: source venv/bin/activate"
echo "2. Run the example: python src/example.py"

