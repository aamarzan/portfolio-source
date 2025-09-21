# Use a stable Python base image
FROM python:3.11-slim

# Enable additional software repositories
RUN sed -i 's/main/main contrib non-free non-free-firmware/g' /etc/apt/sources.list.d/debian.sources

# Install system dependencies, including ViennaRNA for RNAfold
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    vienna-rna \
    && rm -rf /var/lib/apt/lists/*

# Copy the DSSR tool and make it executable
COPY tools/x3dna-dssr /usr/local/bin/
RUN chmod +x /usr/local/bin/x3dna-dssr

# Set up the application directory
WORKDIR /app
RUN mkdir temp_uploads

# Install Python packages
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application files
COPY . .

# Run the Gunicorn server, listening on the port provided by Cloud Run
CMD ["gunicorn", "--bind", "0.0.0.0:$PORT", "--workers", "1", "--timeout", "600", "app:app"]