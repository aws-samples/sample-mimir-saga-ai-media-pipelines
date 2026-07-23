FROM public.ecr.aws/lambda/python:3.12

# Install system dependencies for Chromium + FFmpeg
RUN dnf install -y \
    gcc \
    gcc-c++ \
    make \
    wget \
    tar \
    xz \
    nodejs \
    npm \
    atk \
    cups-libs \
    gtk3 \
    libXcomposite \
    libXcursor \
    libXdamage \
    libXext \
    libXi \
    libXrandr \
    libXScrnSaver \
    libXtst \
    pango \
    xorg-x11-fonts-100dpi \
    xorg-x11-fonts-75dpi \
    xorg-x11-fonts-cyrillic \
    xorg-x11-fonts-misc \
    xorg-x11-fonts-Type1 \
    xorg-x11-utils \
    alsa-lib \
    && dnf clean all

# Install a static FFmpeg build
RUN wget -q https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
    && tar -xf ffmpeg-release-amd64-static.tar.xz \
    && mv ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ffmpeg \
    && mv ffmpeg-*-amd64-static/ffprobe /usr/local/bin/ffprobe \
    && rm -rf ffmpeg-*-amd64-static* \
    && chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe

# Install Node.js dependencies for Lottie rendering
COPY package.json ${LAMBDA_TASK_ROOT}/
RUN cd ${LAMBDA_TASK_ROOT} && npm install

# Install Chromium for Puppeteer into a fixed path inside the image.
# PUPPETEER_CACHE_DIR must be set at build time AND runtime so Puppeteer
# always finds Chrome regardless of which user Lambda runs as.
ENV PUPPETEER_CACHE_DIR=/var/task/.cache/puppeteer
RUN cd ${LAMBDA_TASK_ROOT} && npx puppeteer browsers install chrome

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy handler code and assets
COPY index.py ${LAMBDA_TASK_ROOT}/
COPY render_lottie.js ${LAMBDA_TASK_ROOT}/
# Stub font served to lottie-web for font loading — actual glyphs come from chars array
COPY DejaVuSans.ttf ${LAMBDA_TASK_ROOT}/

CMD ["index.handler"]
