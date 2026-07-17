FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
COPY assets /usr/share/nginx/html/assets
RUN mkdir -p /usr/share/nginx/html/books
COPY books/Clone_Centre_Prompt_Guidebook.pdf /usr/share/nginx/html/books/Clone_Centre_Prompt_Guidebook.pdf
RUN chmod -R a+r /usr/share/nginx/html
EXPOSE 80
