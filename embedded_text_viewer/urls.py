from django.urls import path
from . import views

urlpatterns = [
    path('api/extract-spans', views.extract_spans, name='etv-extract-spans'),
]
