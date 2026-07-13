from django.urls import path
from . import views

urlpatterns = [
    path('widths', views.calculate_widths, name='calculate_widths'),
    path('fonts-list', views.list_fonts, name='list_fonts'),
]
