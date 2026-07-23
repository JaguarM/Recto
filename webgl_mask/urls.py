from django.urls import path
from . import views

urlpatterns = [
    path('webgl/masks', views.generate_masks, name='generate_masks'),
    path('webgl/mask/<str:doc_hash>/<int:page_num>', views.page_mask, name='page_mask'),
]
