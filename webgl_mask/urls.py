from django.urls import path
from . import views

urlpatterns = [
    path('webgl/masks', views.generate_masks, name='generate_masks'),
]
