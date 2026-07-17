FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
COPY assets /usr/share/nginx/html/assets
COPY books /usr/share/nginx/html/books
RUN chmod -R a+r /usr/share/nginx/html
EXPOSE 80
